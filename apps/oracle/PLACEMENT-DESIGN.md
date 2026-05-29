# Latency-Based Region Placement — Design

Status: **design + buildable slice**. What ships today is the pure scorer
(`src/lib/placement.ts`), the `POST /api/servers/recommend-region` endpoint, and
a Node TCP-connect RTT prober in `@hachiman/hachiman-node`. The scheduler,
islands, and per-island metrics described here are **future** and intentionally
unbuilt (see `REGION-CONTRACT.md` → "Explicitly out of scope").

## 1. The thesis: place near the *users*, not the owner

A server's region today is chosen by its owner from a dropdown — effectively
"where the owner is". That is the wrong signal. Voice latency is dominated by
the network distance between the **talking users** and the box mixing their
audio. The owner may live nowhere near the userbase.

So: pick the region with the **lowest measured client→region RTT**, aggregated
over the server's actual users. Region affinity is the dominant term; everything
else is a tiebreaker.

### On-path / geodesic reasoning

The SFU (the WebRTC mixer in `pkg/web`) is roughly **neutral when it sits on the
network path** between participants. If two users in EU talk through a box that
is also in EU, the mixer adds ~one local RTT. The pathological case is a mixer
placed *off* the great-circle path between users (e.g. EU users mixed in
us-west): every packet detours, doubling propagation delay. Hence "nearness to
the users" — not "nearness to the owner", and not raw geodesic distance to a
fixed point — is what we optimise. `regions.lat/lon` exist for a *coarse* prior
(rank candidates before any probe data arrives), but measured RTT always wins
over geodesic estimate when both are present.

## 2. The scorer (built)

`scorePlacement(candidates, { rttToleranceMs })` is pure (no IO/DB/clock):

- **Affinity dominates.** If two regions' RTTs differ by more than
  `rttToleranceMs` (default 15ms — sub-perceptible for voice, wide enough to
  swallow probe jitter), the lower RTT wins outright. A far-but-idle region can
  never beat a near-but-busy one.
- **Bin-pack is the tiebreaker** *within* the tolerance band:
  `load = (activeUsers/maxUsers)*0.5 + cpuPct*0.3 + bandwidthPct*0.2`
  (each component clamped to [0,1]; lower = less loaded). Used only to spread
  placement across equally-near regions and avoid hot-spotting one island.
- **Missing data is tolerated.** No load ⇒ ordered purely by RTT; within a band,
  a region with known load beats one with unknown load. No measured RTT ⇒ the
  region is *unrankable* and reported separately, never silently chosen.

## 3. The prober — buildable now vs. ideal

### Built: TCP connect-time RTT (`region-rtt-probe.ts`, Node)

`probeRegionsRtt(targets)` opens a TCP socket to each region's `host:port`
(Mumble listens TLS/TCP on the same port it answers UDP pings on), times
`connect()` → `connect` event (the SYN→SYN/ACK round-trip), takes the **min**
over N samples, and destroys the socket without sending data. That min is a
sound network-distance proxy: it is one round-trip, exactly like a ping, and
needs no protobuf wire and no new deps — just node `net` (the primitive the TLS
transport already uses). Failures surface as `rttMs: null` (→ unrankable).

**Limitations:** Node-only (browsers can't open raw TCP either); a dropped SYN
retransmits on a coarse timer, so a single sample can over-report on a lossy
path — hence multi-sample + min. The browser host should instead time a
WebSocket/HTTPS handshake against a per-region endpoint (not built here).

### Ideal: Mumble connectionless server-browser ping (UDP)

The Go server already answers a 12-byte UDP datagram at
`cmd/grumble/server.go` (`udpListenLoop`, the `nread == 12` branch) with a
24-byte reply — **no auth, no connection**:

```
request  (12B):  uint32 ident(ignored) | uint64 nonce
reply    (24B):  uint32 version | uint64 nonce(echoed) | uint32 userCount
                 | uint32 maxUsers | uint32 maxBandwidth        (all big-endian)
```

This is the *right* probe: voice rides UDP, so a UDP RTT reflects the real
voice path, and the reply piggybacks live `userCount`/capacity straight into the
scorer's bin-pack `load`. The pure encode/decode is **already implemented and
unit-tested** (`buildServerBrowserPing` / `parseServerBrowserPong`). It is not
wired to a socket because this client has no raw UDP transport yet
(`TODO.md`: "Add Node UDP Socket support"). When UDP lands: send the ping, await
the datagram, verify the nonce echo, compute `now − sentAt`. Browsers stay on
the WebSocket/HTTPS fallback (no raw UDP in the platform).

## 4. The future scheduler

A periodic job (NOT built — no islands/Redis exist) that closes the loop:

1. **Collect metrics.** Each running island publishes utilisation to Redis under
   `island:{id}:metrics` (`activeUsers`, `maxUsers`, `cpuPct`, `bandwidthPct`,
   TTL'd so a dead island ages out). The scheduler reads these as the scorer's
   `load`. (Island↔region join key is `regions.code`, per REGION-CONTRACT.md.)
2. **Collect RTTs.** Aggregate per-server client→region RTTs reported via
   `recommend-region` (and/or active probes from a measurement fleet), keyed by
   the server's userbase, into a representative RTT per region (e.g. p50 over
   recently-active users).
3. **Score & decide.** Run `scorePlacement` per server. If the recommended
   region differs from `servers.region` by a margin (RTT improvement beyond the
   tolerance band, sustained over a debounce window to avoid flapping on a few
   roaming users), flag a re-home.

### Re-home trigger (userbase-RTT shift)

Re-homing is a **cold migration** and must be rare and deliberate. The single
write path for region is the `region` branch of `updateServer`
(`src/lib/servers.ts`) — per REGION-CONTRACT.md that is the one call site the
fan-out hooks. The scheduler, on a sustained better-region signal, calls that
branch (the contract suggests extracting a dedicated `reHomeServer` from it once
a consumer exists), which then: select target island (geodesic prior +
population) → drain/announce → spin up on the new island → swap advertised host
→ tear down old placement. The dashboard already warns owners that changing
region "may briefly interrupt voice", so the UX contract for an automated
re-home is already in place. Re-home auditing and rate-limiting live at that
same call site.

### Why the registry stays thin

Islands, vServer lifecycle, the wake proxy, and per-island metrics are all
managed-infra concerns deliberately absent from the Oracle registry. This design
consumes only `regions.code` + `servers.region` (the stable contract) and the
pure scorer, so the infra layer can be built later without re-touching the
schema.
