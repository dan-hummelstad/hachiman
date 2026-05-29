# Thin & On-Path Voice Relays — Design

Status: **instrumentation + guard + benchmark are real today** (this PR). The
managed-infra topology described below (regional ingress, on-host wake proxy,
islands, TURN) is the **target architecture this instrumentation is built to
enforce** — it does **not** exist yet. Nothing here builds islands, a wake
proxy, or ingress; it makes the *invariants* those pieces must satisfy
measurable against the **current** SFU so they can be added without re-litigating
correctness.

Companion contract: [`apps/oracle/REGION-CONTRACT.md`](../oracle/REGION-CONTRACT.md)
(the mutable `servers.region` → Go `ServerRegion` key this reads).

---

## 1. Goal & two invariants

A voice relay must be:

1. **THIN** — the forwarding hop adds negligible latency. The relay forwards
   media; it does not transcode, buffer, or detour it. Steady-state added
   latency should be ~0 over and above the unavoidable kernel/NIC send.
2. **ON-PATH** — voice never crosses regions. A packet between two participants
   in `us-east` must be relayed by a `us-east` relay, never hair-pinned through
   `eu-west`. Cross-region detours add tens-to-hundreds of ms and defeat
   regional placement entirely.

This document defines the target topology, the latency budget, and exactly how
the shipped guard/metrics enforce the on-path invariant.

---

## 2. Target topology: regional ingress + on-host wake proxy

```
        ┌────────────────────── region: us-east ──────────────────────┐
 client │                                                              │
  ──────┼──► regional L4 ingress ──► on-host wake proxy ──► Murmur/SFU  │
 (UDP/  │    (anycast/regional VIP)   (localhost:64738)     (vServer on │
  WS/   │                                  │                  island)   │
  TLS)  │                                  └─ steady state: a localhost │
        │                                     forward ⇒ ~0 added latency│
        └──────────────────────────────────────────────────────────────┘
```

- **Regional L4 ingress** — a region-local entry point (anycast or a regional
  VIP) that terminates nothing it doesn't have to; it forwards L4 to the
  on-host proxy. Being *regional* is what keeps the path on-path: a client is
  steered to the ingress for the server's region, so the first hop is already
  in-region.
- **On-host wake proxy** — co-located with Murmur on the island host. It exists
  to *wake* a cold/idle vServer (scheduler spins it up on demand) and then get
  out of the way. Once awake, it is a **localhost → Murmur** forward:
  **~0 steady-state added latency** because it is a loopback hop with no
  cross-host network in the path.
- **Island / vServer** — a placed Murmur+SFU instance bound to a host inside the
  region (REGION-CONTRACT §3). The SFU is the only component that touches media
  payloads, and even it only re-stamps RTP headers and forwards (see §4).

### 2.1 Regional-L4 vs direct-island addressing (the tradeoff)

| Approach | How clients reach voice | Pros | Cons |
| --- | --- | --- | --- |
| **Regional L4 ingress** (recommended default) | Client → stable regional VIP/anycast → wake proxy → vServer | Stable advertised host survives re-home/cold-migration; ingress can wake an idle vServer; hides island churn; natural place to enforce "in-region first hop" | One extra L4 forward (kept thin/in-region); ingress is a regional dependency to run |
| **Direct island addressing** | Client → island host:port directly | One fewer hop; simplest data path | Advertised host changes on every re-home (client reconnect/interruption); no wake path (host must be hot); leaks placement; easy to mis-address a client into the *wrong region* (an off-path footgun) |

**Recommendation:** regional L4 ingress as the steady-state default; the wake
proxy makes the extra hop a localhost forward once warm, so the "fewer hops"
argument for direct addressing mostly evaporates while you keep stable
addressing + wake + on-path enforcement. Direct island addressing is acceptable
only for always-hot, single-island regions where re-home is rare.

### 2.2 TURN must be regional (WebRTC)

Browser clients use WebRTC; when a peer can't get a direct/STUN-reflexive path
it relays through **TURN**. **TURN servers must be deployed per-region and the
client must only be handed in-region TURN URIs.** A globally-shared or
wrong-region TURN relay silently turns an "on-path" SFU into an off-path one:
the SFU is in `us-east`, but media tromboned through a `eu-west` TURN server
before it ever reached the SFU. Regional TURN keeps the ICE-relayed path
in-region. (The SFU's `webrtc.Configuration{}` is where ICE servers are set;
that list must be region-scoped when TURN is added — it is empty today.)

---

## 3. Latency budget — what "thin" means

The relay's own per-packet work is the only latency it controls. Measured
against the **current** SFU on this PR (Apple M4, `go test -bench`, see
`pkg/web/relaymetrics_bench_test.go`):

| Operation | ns/op | allocs/op | Notes |
| --- | --- | --- | --- |
| `ForwardToWebRTC` full hop | **~70 ns** | **0** | RTP re-stamp + `WriteRTP` (unbound track isolates SFU CPU work) |
| On-path instrumentation only | **~3.8 ns** | **0** | added by this PR; ~5% of the hop |
| `ObserveHopLatency` | **~1.7 ns** | **0** | atomic accumulate |
| Concurrent forwards (`RunParallel`) | **~170 ns** | **0** | atomics under fan-out, no contention cliff |

Budget: **`DefaultHopLatencyBudget = 2 ms`** per forwarding hop
(`pkg/web/relaymetrics.go`). This is generous next to the ~70 ns of CPU work —
the headroom absorbs scheduler jitter and a localhost wake-proxy hop while still
catching a real regression (GC stall, CPU starvation, or an accidental
cross-host/cross-region network hop sneaking into the path). `ObserveHopLatency`
flags every observation over budget (`Hop.OverBudgetCount` in the snapshot);
sustained breaches are the "relay no longer thin" alert.

**Key result:** the on-path instrumentation adds ~3.8 ns and **zero
allocations** per packet, so making the relay *verifiable* does not make it
*un-thin*.

---

## 4. The on-path invariant and how the guard/metrics enforce it

### 4.1 Single source of truth

`EvaluatePath(relayRegion, senderRegion, receiverRegion) PathVerdict`
(`pkg/web/relaymetrics.go`) is the **one** definition of on-path, and it is a
pure, allocation-free function:

- **`PathOnPath`** — relay is placed and every *known* participant region equals
  the relay's region.
- **`PathOffPath`** — relay is placed and a known participant region differs →
  cross-region detour.
- **`PathUnknown`** — relay unplaced, or all participant regions unknown → cannot
  prove a detour (not penalised).

Empty string = "unplaced / unknown", matching REGION-CONTRACT's empty
`ServerRegion` / null `servers.region`.

### 4.2 Runtime enforcement (metrics)

- `NewSFU(logger, cfg.StringValue("ServerRegion"))` tags the relay with its
  region at construction.
- Both forwarding paths report into one `RelayMetrics`:
  - **WebRTC**: `pkg/web/sfu.go` `ForwardToWebRTC` → `RecordWebRTCForward`.
  - **Native UDP**: `cmd/grumble/voice_broadcast.go` `Broadcast` → the
    `SendUDP` loop → `RecordNativeForward`.
- Each forward is classified (on/off/unknown) with **atomic counters only**.
  Off-path forwards increment `OffPathCount`; any non-zero total flips the
  snapshot's `OnPath` flag to `false`.
- Logging is **sampled** (1 line / `defaultSampleEvery = 1000` forwards) behind
  an atomic tick, and off-path samples emit a dedicated greppable
  `relay-OFF-PATH` line. **No logging or map writes happen per packet.**
- `GET /metrics/relay` (mounted in `server.go`) serves the JSON snapshot for
  operators / the UI Health tab. Read-only, off the hot path. *(Not yet
  auth-gated — see §6.)*

Today every directly-served participant is in the relay's region by topology,
so the runtime path passes `relayRegion` for receivers and reads on-path. The
counters are wired so that **the moment** a per-client region is threaded
through (when ingress/islands land) or a relay is mis-homed, off-path forwards
start counting with zero further plumbing.

### 4.3 CI enforcement (guard test)

`pkg/web/relaymetrics_guard_test.go` is the off-path guard:

- `TestEvaluatePath_Invariant` — exhaustive truth table for the invariant.
- `TestOffPathGuard_DetectsCrossRegionDetour` — an on-path forward must read
  on-path; a cross-region forward must flip `OnPath=false`.
- `TestOffPathGuard_FailsForMisHomedRelay` — a relay homed in the wrong region
  for its participants **must** be reported as a violation (the CI failure the
  task asks for).
- `TestUnplacedRelayIsNotFlaggedAsOffPath` — no false positives for legacy /
  unconfigured relays.
- `TestInstrumentationAllocFree` (in `relaymetrics_bench_test.go`) — hard gate:
  the hot-path entry points allocate **0** times/op.

---

## 5. The "thin" benchmark

`pkg/web/relaymetrics_bench_test.go` benchmarks the forwarding hop against the
current SFU to establish/regress-guard the thin baseline:

```bash
cd apps/hachiman-server
GOCACHE="$TMPDIR/gocache" go test ./pkg/web/ -run '^$' -bench 'Forward|Record|Hop|Observe' -benchmem
```

`BenchmarkForwardToWebRTC_Hop` drives a real `pion` `TrackLocalStaticRTP`; the
`BenchmarkRecordForward_*` benches isolate the instrumentation cost; the
`_Parallel` bench checks the shared atomics under concurrent fan-out. All report
`0 allocs/op`.

---

## 6. What to monitor

From the `/metrics/relay` snapshot (`RelaySnapshot`):

- **`onPath` / `totalOffPath`** — the headline. `onPath=false` (or
  `totalOffPath` climbing) ⇒ voice is detouring across regions: page someone.
  This is the single most important signal; an on-path relay should hold
  `totalOffPath == 0` forever.
- **`hop.overBudgetCount` / `hop.maxMillis`** — "relay no longer thin". A rising
  over-budget rate ⇒ CPU starvation, GC pauses, or an unexpected network hop in
  the path (e.g. wake proxy not co-located, or wrong-region TURN).
- **`hop.meanMillis`** — steady-state added latency; should track the ~tens-of-µs
  CPU baseline (well under the 2 ms budget) once warm.
- **`regionForwards`** — per-receiver-region forward tally (sampled). On a
  correctly-placed relay this is a single key == the relay's region. Extra keys
  are early evidence of mis-routing.
- **`transports[].drops`** — best-effort forward write failures; a proxy for SFU
  back-pressure / track teardown races.

### Follow-ups (not in this PR)

- **Auth-gate / private-bind `/metrics/relay`** before production exposure
  (operator-only).
- **Per-client region** on `Client` (sourced from ingress / the Oracle registry)
  so the on-path classifier compares real participant regions instead of
  assuming directly-served clients are in-region.
- **Regional TURN URIs** in the SFU's ICE config (§2.2) — empty today.
- A proto/message change would be needed to surface relay metrics to clients
  over the Mumble control channel; **explicitly deferred** (do not hand-edit
  generated proto). The HTTP snapshot is the interim transport.
```
