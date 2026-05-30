# Grumble Internal Management gRPC API

## What this is

An **internal** gRPC control surface on the Grumble Go server that lets a
control plane (the Oracle) create and delete virtual servers (vServers) at
runtime on a *running* Grumble process. Without this, vServers can only be
loaded/created at process boot — there's no way for the scheduler in
`apps/oracle/src/lib/islands.ts` to drive `placeVServer + transitionVServer('starting')`
on an island without restarting it.

This is **NOT** the Mumble control channel. Clients still talk standard
Mumble over TLS/WebSocket on port 64738. This service is purely an
out-of-band admin API and is **disabled by default** (zero-config self-host
behaviour is unchanged — see "Compatibility" below).

## Compatibility

- **Self-host (zero-config) is unchanged.** `ManagementListen=""` (the default)
  skips listener startup entirely — no extra port, no goroutines, no extra log
  lines.
- **Go version bump.** This package pulls in `google.golang.org/grpc v1.81.1`,
  whose own `go.mod` requires **`go 1.25.0`** (its transitive `golang.org/x/*`
  set also requires it). The repo's `go.mod` directive moves from `1.21` to
  `1.25.0` as a result. It cannot be pinned back without downgrading grpc; the
  earlier Postgres-backend work deliberately stayed on 1.21 because that landed
  before the grpc dep.

## API surface (MVP)

Proto: `pkg/management/management.proto`. Package: `grumble.management.v1`.

```protobuf
service GrumbleManagement {
  rpc CreateVirtualServer(CreateVirtualServerRequest) returns (CreateVirtualServerResponse);
  rpc DeleteVirtualServer(DeleteVirtualServerRequest) returns (DeleteVirtualServerResponse);
}
```

- **`CreateVirtualServer`** — allocates a new vServer row (`tx.ServerAdd`)
  AND boots it in-process (`NewServer` + `Start` + `registry.Register`).
  Returns the allocated `server_id` (int64). Request currently empty —
  Grumble's `ServerAdd()` takes no parameters; per-server config is set
  out-of-band afterwards (see "Deferred").
- **`DeleteVirtualServer`** — stops the vServer in-process (if running) and
  removes the DB row (`tx.ServerDelete`). Returns `NotFound` when the id
  exists in neither the DB nor the in-process registry; `InvalidArgument`
  when `server_id <= 0`. Stop-first-then-delete order so we never leave the
  server briefly accepting connections it can no longer authenticate.

### Deferred to a follow-up (NOT in this MVP)

- **`GetStats`** — live user count, CPU, bandwidth. Cheap to add; the
  numbers exist already (`len(server.clients)`, the bandwidth recorder).
  The reason it's not here: those numbers are what the Oracle stores in
  Redis (see `apps/oracle/ISLAND-PLATFORM.md` §4) — they're a *push* from
  the island, not a pull. A `GetStats` RPC would only be useful for ad-hoc
  debugging.
- **`SetConfig`** — push runtime config keys (`Address`, `Port`,
  `MaxUsers`, …) onto a running vServer. Currently the per-vServer config
  map lives in the DB and is read lazily by `cfg.StringValue` etc., so a
  control plane *can* already mutate it by writing the DB row directly —
  but a dedicated RPC would (a) be type-safe and (b) trigger a hot reload
  for keys that need it (most don't).

## Registry hookup in `main()`

The boot flow in `cmd/grumble/grumble.go` `main()` was extended in two
places:

1. **Population**: a `*ServerRegistry` is allocated once, and every server
   that successfully `Start()`s — both those loaded from the DB and the
   default-created one when the DB is empty — is added to it. This is the
   single source of truth for "what's running in this process".
2. **Optional gRPC server**: after the boot loop, if `ManagementListen` is
   non-empty, `main()` constructs the service + listener and launches
   `mgmt.Serve()` in its own goroutine. Empty `ManagementListen` (the
   default) skips this entirely — no extra port, no extra goroutines.

The management package can't import `cmd/grumble` (it's `package main`),
so the bridge is a small interface: `management.VServerLifecycle` declares
`CreateAndStart / StopAndRemove / Exists`; `cmd/grumble/management_lifecycle.go`
implements it by holding the `*ServerRegistry` and calling
`NewServer`/`Start`/`Stop` directly.

## `Server.Stop()` cleanup

Grumble's `Server.Stop()` already existed and tore down the bulk of the
per-server state (listeners, handler goroutine via `bye`, web HTTP server,
SFU client state via `RemoveClient` cascading from `Disconnect`,
`netwg.Wait`). The only stranded goroutine after a runtime `Delete` was
the deferred `RegisterPublicServer` timer scheduled inside `Start()` — it
slept 1 minute unconditionally and then either no-op'd (non-public server)
or made an HTTP POST.

Fix: added a per-server `stopCh chan struct{}` (allocated in
`initPerLaunchData`, closed at the top of `Stop`, cleared in
`cleanPerLaunchData`). The registration goroutine now uses a `select` over
`time.After(1*time.Minute)` and `<-server.stopCh`, so a `Delete` no longer
leaves a 1-minute-pending goroutine attached to a defunct server.

Verified via `TestCreateDelete_NoGoroutineLeak`: 5 Create/Delete cycles
end with `runtime.NumGoroutine()` delta ≤ 2 (scheduler noise tolerance).
The real `Server.Stop()` path isn't exercised by that test (it would need
TLS cert files / sockets) — it's covered by the manual managed-smoke test
described below.

## Security posture (MVP)

**Localhost-bind, no auth.** This is intentional and documented in the
`pkg/management/service.go` header comment + `serverconf.DefaultCfg`
comment + the `--management-listen` flag help.

- `ManagementListen=""` (the default) → API disabled, no port opened.
- `ManagementListen="127.0.0.1:50051"` (or `[::1]:port`, or `localhost:port`)
  → API enabled on loopback only.
- A non-loopback host (e.g. `0.0.0.0:50051`, `192.168.1.5:50051`) is
  **rejected at startup** by `requireLoopback` in `pkg/management/listener.go`.
  This is a HARD safety rail, not advisory.

The omitted-host form (`:50051`) is also rejected — Go's `net.Listen` would
bind to all interfaces, which is the most common way to leak the API
accidentally.

### Production exposure (follow-up, NOT in this MVP)

When the API needs to be reachable across the network (Oracle ↔ island in
a non-collocated topology), one of:

- **mTLS**: terminate gRPC behind `grpc.Creds(creds)` with a known CA;
  require client cert verification.
- **OR a shared bearer token**: a `UnaryInterceptor` that constant-time
  compares a token in incoming metadata.

The `requireLoopback` check would then be relaxed (or replaced with an
explicit "I have configured auth" config key).

## Operator contract: single-writer per `server_id`

The MVP serializes operations only WITHIN a single Create or Delete call, not
ACROSS calls for the same `server_id`. The control plane (Oracle) is the
natural single writer per id (it allocates an id via Create → records it → and
only later Deletes that id), and as long as it does not race itself on the
same id, all operations stay coherent.

In the unlikely event two callers race a Create-vs-Delete for an id mid-flight
(e.g. a Delete arriving between Create's `tx.Commit()` and the in-process
`CreateAndStart`), the Delete can return success while the late-bound Create
restores a server on the same row (`ServerInit` is create-if-not-exists). A
follow-up adding a per-id mutex around Create/Delete in
`pkg/management/service.go` would close this; it is deferred because the only
realistic caller — the Oracle scheduler — is single-writer-per-id by
construction.

## Oracle wiring (out of scope for this team — for reference only)

The Oracle's scheduler in `apps/oracle/src/lib/islands.ts` (per
`ISLAND-PLATFORM.md` §3) currently produces a placement decision and is
expected to call:

1. `placeVServer(vsId, islandId)` — sets `virtual_servers.islandId` in the
   Oracle DB.
2. `transitionVServer(vsId, 'starting')` — drives the lifecycle.

At step 2, the *next* component (the "wake proxy" / island controller,
deferred per `ISLAND-PLATFORM.md` §4) will dial the island's
`grpcPort` and call **`CreateVirtualServer`** on this API. The returned
`server_id` is the `murmurId` to write back into `virtual_servers.murmurId`.

`unplaceVServer` + a `cooling → inactive` transition would similarly call
**`DeleteVirtualServer`** with the stored `murmurId`.

Both call sites are **out of scope for this team** — this PR only ships
the API the island side of those calls needs.

## Files added / changed

```
apps/hachiman-server/
  cmd/grumble/
    grumble.go                       (modified — registry + optional mgmt listener)
    args.go                          (modified — --management-listen flag, MANAGEMENT_LISTEN env)
    server.go                        (modified — stopCh, registration timer fix)
    server_registry.go               (new — thread-safe in-process registry)
    server_registry_test.go          (new)
    management_lifecycle.go          (new — VServerLifecycle adapter)
  pkg/serverconf/
    config.go                        (modified — ManagementListen key)
  pkg/management/                    (new package)
    management.proto                 (new — gRPC service definition)
    management.pb.go                 (generated)
    management_grpc.pb.go            (generated)
    generate.go                      (new — //go:generate stanza)
    lifecycle.go                     (new — VServerLifecycle interface)
    service.go                       (new — GrumbleManagementServer impl)
    listener.go                      (new — Listen() + requireLoopback)
    service_test.go                  (new)
    grpc_e2e_test.go                 (new — real grpc.Server + client)
  go.mod / go.sum                    (modified — google.golang.org/grpc dep)
  MANAGEMENT-API.md                  (this file)
```

## Build & verification

```sh
# Build (sandbox needs Go module cache write access, hence dangerously off):
cd apps/hachiman-server && GOCACHE="$TMPDIR/gocache" go build ./...
GOCACHE="$TMPDIR/gocache" go vet ./pkg/management/... ./cmd/grumble/...
GOCACHE="$TMPDIR/gocache" go test ./pkg/management/... ./cmd/grumble/...
GOCACHE="$TMPDIR/gocache" go test -race ./pkg/management/... ./cmd/grumble/...

# Regenerate proto bindings after editing management.proto:
cd apps/hachiman-server/pkg/management
PATH="$(go env GOPATH)/bin:$PATH" \
  protoc --go_out=. --go_opt=paths=source_relative \
         --go-grpc_out=. --go-grpc_opt=paths=source_relative \
         management.proto
# (one-time: go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
#            go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest)
```
