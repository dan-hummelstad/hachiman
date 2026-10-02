# Latency-Based Region Placement — Design

What ships today: the pure scorer (`src/lib/placement.ts`), the
`POST /api/v1/regions/recommend` endpoint that feeds it client-measured RTTs,
and media-node placement (`src/grpc/placement.ts`, the `PlaceMediaSession` RPC).

## 1. The thesis: place near the *users*, not the owner

A guild's region today is chosen by its owner from a dropdown — effectively
"where the owner is". That is the wrong signal. Voice latency is dominated by
the network distance between the **talking users** and the box mixing their
audio. The owner may live nowhere near the userbase.

So: pick the region with the **lowest measured client→region RTT**, aggregated
over the guild's actual users. Region affinity is the dominant term; everything
else is a tiebreaker.

### On-path / geodesic reasoning

The SFU (`hachiman-media`) is roughly **neutral when it sits on the
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
  placement across equally-near regions and avoid hot-spotting one region.
- **Missing data is tolerated.** No load ⇒ ordered purely by RTT; within a band,
  a region with known load beats one with unknown load. No measured RTT ⇒ the
  region is *unrankable* and reported separately, never silently chosen.

## 3. Region probing

Clients fetch `GET /api/regions` (`code`, `displayName`, `probeHost`,
`probePort`), measure RTT to each region, and POST the results to
`/api/v1/regions/recommend`. The Electron host measures TCP connect time (min
over several samples); browsers cannot open raw sockets. A failed probe is
`rttMs: null` and the region is reported as unrankable.

## 4. Media-node placement

`hachiman-media` nodes register and heartbeat with Takusen over gRPC
(`RegisterMediaNode`, `MediaNodeHeartbeat`) into `media_nodes`. When a voice
channel has no node yet, the gateway calls `PlaceMediaSession` with the guild's
home region. Takusen returns the least-loaded node in that region: `status =
'active'`, a heartbeat within the last 30s, ordered by `active_sessions` then
`node_id`. The gateway then pins the channel to that node in Redis
(`voice_room:{channelId}`), so every user in a channel lands on the same node.
