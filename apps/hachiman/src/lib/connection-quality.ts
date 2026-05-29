/**
 * Shared types + helpers for the two voice-health surfaces:
 *
 *   • the CLIENT connection-quality indicator in `voice-controls.tsx`
 *     (round-trip time / jitter / packet-loss for *this* client's session), and
 *   • the OPERATOR relay-path Health tab in `server-settings-dialog.tsx`
 *     (the server-side "is voice thin & on-path?" view).
 *
 * IMPORTANT — placeholder wiring, not fabricated data. The Go server exposes a
 * `RelaySnapshot` over `GET /metrics/relay` (see
 * `apps/hachiman-server/pkg/web/relaymetrics.go`), and the Mumble Ping message
 * carries client UDP stats — but neither is currently threaded through
 * `IMumbleService` to the shared UI. So these types describe the *shape* both
 * views render, and every field is explicitly nullable: a `null`/`undefined`
 * value means "no live data yet", which the UI renders as a clearly-marked
 * "unavailable / measuring" state rather than inventing numbers.
 *
 * When the client library starts populating round-trip stats and a metrics
 * passthrough lands on `IMumbleService`, populate these slots and the existing
 * UI lights up with zero rework.
 */

// ── Client-side connection quality ──────────────────────────────────────────

/**
 * Per-session connection quality as measured by the Mumble client. All fields
 * are nullable; `null` = not yet measured / unavailable.
 *
 * Mirrors what the Mumble Ping exchange can yield:
 *  - `rttMs`        — round-trip time to the server (TCP control-channel ping).
 *  - `jitterMs`     — variance in inter-packet arrival for received voice.
 *  - `packetLoss`   — fraction in [0,1] of expected voice packets not received
 *                     (derived from the Ping `good`/`late`/`lost` counters).
 *  - `transport`    — which voice transport is active, for operator context.
 */
export interface ConnectionQuality {
  rttMs: number | null
  jitterMs: number | null
  packetLoss: number | null
  transport: 'udp' | 'webrtc' | 'tcp-tunnel' | null
  /** ms epoch of the last sample; null when never sampled. */
  sampledAt: number | null
}

export const EMPTY_CONNECTION_QUALITY: ConnectionQuality = {
  rttMs: null,
  jitterMs: null,
  packetLoss: null,
  transport: null,
  sampledAt: null
}

export type QualityTier = 'good' | 'fair' | 'poor' | 'unknown'

/**
 * Collapse a quality sample into a single tier for the status dot. Thresholds
 * are deliberately conservative VoIP rules of thumb (RTT and loss dominate
 * perceived call quality). Returns 'unknown' when there is nothing measured.
 */
export function classifyQuality(q: ConnectionQuality | null | undefined): QualityTier {
  if (!q) return 'unknown'
  const { rttMs, jitterMs, packetLoss } = q
  if (rttMs == null && jitterMs == null && packetLoss == null) return 'unknown'

  let tier: QualityTier = 'good'
  const demote = (to: QualityTier): void => {
    const order: QualityTier[] = ['good', 'fair', 'poor']
    if (order.indexOf(to) > order.indexOf(tier)) tier = to
  }

  if (rttMs != null) {
    if (rttMs > 250) demote('poor')
    else if (rttMs > 120) demote('fair')
  }
  if (packetLoss != null) {
    if (packetLoss > 0.05) demote('poor')
    else if (packetLoss > 0.01) demote('fair')
  }
  if (jitterMs != null) {
    if (jitterMs > 50) demote('poor')
    else if (jitterMs > 30) demote('fair')
  }
  return tier
}

/** Tailwind text/bg color hints for a tier; keep in one place so both
 * surfaces stay consistent. */
export const QUALITY_TIER_COLOR: Record<QualityTier, string> = {
  good: 'bg-green-500',
  fair: 'bg-yellow-500',
  poor: 'bg-destructive',
  unknown: 'bg-muted-foreground'
}

export const QUALITY_TIER_LABEL: Record<QualityTier, string> = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  unknown: 'Unknown'
}

/** Format a millisecond value, or an em-dash placeholder when unavailable. */
export function fmtMs(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return `${Math.round(v)} ms`
}

/** Format a [0,1] loss fraction as a percentage, or a placeholder. */
export function fmtLoss(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return `${(v * 100).toFixed(1)}%`
}

// ── Operator relay-path snapshot (mirror of Go RelaySnapshot) ────────────────

/**
 * One hop on the voice forwarding path, for the operator Health tab. `latencyMs`
 * is the added latency of this hop; `region` is where the hop sits. Nullable
 * fields render as "unavailable".
 */
export interface RelayPathHop {
  label: string
  region: string | null
  latencyMs: number | null
  /** false when this hop pushes voice across a region boundary. */
  onPath: boolean | null
}

/**
 * The shape the Health tab renders. Mirrors the server's `RelaySnapshot`
 * (region, per-hop latency, on-path verdict). `null` everywhere = no metrics
 * passthrough wired yet.
 */
export interface RelayPathSnapshot {
  relayRegion: string | null
  /** true only when no off-path forwards have been observed. */
  onPath: boolean | null
  /** mean added latency across the forwarding hop, ms. */
  hopMeanMs: number | null
  hopMaxMs: number | null
  hopBudgetMs: number | null
  /** observations exceeding the thin-hop budget. */
  overBudgetCount: number | null
  hops: RelayPathHop[]
}

/**
 * The placeholder snapshot the Health tab shows until a real metrics
 * passthrough exists. It encodes the *expected* topology (client → regional
 * ingress → on-host wake proxy → SFU) with null latencies/regions so the
 * operator sees the intended path shape, clearly labelled as not-yet-wired,
 * without any invented numbers.
 *
 * `relayRegion` may be passed in from data the UI already has (e.g. the
 * server's configured region) so at least the region label is real.
 */
export function placeholderRelayPath(relayRegion: string | null): RelayPathSnapshot {
  return {
    relayRegion,
    onPath: null,
    hopMeanMs: null,
    hopMaxMs: null,
    hopBudgetMs: null,
    overBudgetCount: null,
    hops: [
      { label: 'Client', region: null, latencyMs: null, onPath: null },
      { label: 'Regional ingress', region: relayRegion, latencyMs: null, onPath: null },
      { label: 'Wake proxy (on-host)', region: relayRegion, latencyMs: null, onPath: null },
      { label: 'Voice relay / SFU', region: relayRegion, latencyMs: null, onPath: null }
    ]
  }
}

/**
 * Loosely-typed view of the wire `RelayMetricsSnapshot` (the generated proto
 * type lives in `@hachiman/hachiman-node`, which this shared lib does not
 * depend on). Carries only the fields the Health tab consumes. `uint64` fields
 * arrive as `bigint` over protobuf-ts; the millisecond fields are `double`
 * (plain `number`). Every field is optional to match proto2 presence semantics.
 */
export interface RelayMetricsSnapshotLike {
  region?: string
  onPath?: boolean
  hop?: {
    meanMillis?: number
    maxMillis?: number
    budgetMillis?: number
    overBudgetCount?: bigint | number
  }
}

const numOrNull = (v: number | null | undefined): number | null =>
  v == null || Number.isNaN(v) ? null : v

/**
 * Map the server's `RelayMetricsSnapshot` (fetched over the authenticated
 * control channel via `IMumbleService.fetchRelayMetrics`) onto the
 * `RelayPathSnapshot` shape the Health tab renders.
 *
 * No fabricated data: the relay only measures the added latency of its own
 * forwarding hop, so that figure is attached to the "Voice relay / SFU" hop;
 * the client / regional-ingress / wake-proxy hops keep `null` latency (their
 * timing isn't instrumented). The per-hop `onPath` flag reflects the relay's
 * overall on-path verdict for the relay-side hops, and the region label is the
 * relay's configured region (empty string → null = unplaced).
 */
export function relayPathFromMetrics(snap: RelayMetricsSnapshotLike): RelayPathSnapshot {
  const relayRegion = snap.region && snap.region.length > 0 ? snap.region : null
  const onPath = snap.onPath ?? null
  const hopMeanMs = numOrNull(snap.hop?.meanMillis)
  const hopMaxMs = numOrNull(snap.hop?.maxMillis)
  const hopBudgetMs = numOrNull(snap.hop?.budgetMillis)
  const overBudgetCount =
    snap.hop?.overBudgetCount == null ? null : Number(snap.hop.overBudgetCount)

  return {
    relayRegion,
    onPath,
    hopMeanMs,
    hopMaxMs,
    hopBudgetMs,
    overBudgetCount,
    hops: [
      // Client → ingress → wake-proxy timing is not instrumented; leave null.
      { label: 'Client', region: null, latencyMs: null, onPath: null },
      { label: 'Regional ingress', region: relayRegion, latencyMs: null, onPath },
      { label: 'Wake proxy (on-host)', region: relayRegion, latencyMs: null, onPath },
      // The relay forwarding hop is the one the server actually measures.
      { label: 'Voice relay / SFU', region: relayRegion, latencyMs: hopMeanMs, onPath }
    ]
  }
}
