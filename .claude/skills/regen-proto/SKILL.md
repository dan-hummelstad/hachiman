---
name: regen-proto
description: Regenerate Go and TypeScript protobuf bindings after editing Mumble.proto or MumbleUDP.proto. Both sides MUST be regenerated together — never edit Mumble.pb.go or src/mumbleproto/*.ts by hand. Use this whenever a .proto file has been touched, or when generated files are out of sync.
metadata:
  invocation: user-only
---

# Regenerate protobuf bindings

The canonical `.proto` files live in `apps/hachiman-server/pkg/mumbleproto/`. They are consumed by two languages:

- **Go server** — generated via `protoc` into `Mumble.pb.go` and `MumbleUDP.pb.go` (same directory as the `.proto`).
- **TypeScript client lib** — generated via `@protobuf-ts/plugin` into `pkgs/hachiman-node/src/mumbleproto/*.ts`.

Forgetting either side leads to subtle wire-format drift between server and client.

## Steps

1. **Confirm the `.proto` edit is intentional.** If the user edited only one side's generated file, ask whether they meant to edit the source `.proto` instead.

2. **Regenerate the TypeScript bindings:**
   ```bash
   pnpm -F @hachiman/hachiman-node generate-proto
   ```

3. **Regenerate the Go bindings.** The `package.json` does not currently script this — invoke `protoc` directly from the proto directory:
   ```bash
   cd apps/hachiman-server/pkg/mumbleproto
   protoc --go_out=. --go_opt=paths=source_relative Mumble.proto MumbleUDP.proto
   ```
   If `protoc-gen-go` is missing: `go install google.golang.org/protobuf/cmd/protoc-gen-go@latest`.

4. **Verify both sides compile:**
   ```bash
   pnpm -F @hachiman/hachiman-node build
   pnpm -F hachiman-server build
   ```

5. **If a new message type was added**, the [[add-mumble-message]] skill covers the additional wiring required (type-ID constants, registry entries, handler dispatch).

## What NOT to do

- **Do not** edit `Mumble.pb.go`, `MumbleUDP.pb.go`, or any file under `src/mumbleproto/` directly — they are clobbered on regen.
- **Do not** regenerate only one side. Server/client drift is the failure mode this skill exists to prevent.
- **Do not** commit generated changes that you have not visually diffed against the `.proto` edit. A spurious regen with a different `protoc` version produces noisy diffs.
