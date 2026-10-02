// Client connection quality for the voice connected panel. `null` = not measured.
// RTT = gateway heartbeat RTT; jitter/loss from VoiceConnection.getStats().

export interface ConnectionQuality {
  rttMs: number | null
  jitterMs: number | null
  packetLoss: number | null
  /** ms epoch of the last sample; null when never sampled. */
  sampledAt: number | null
}

export const EMPTY_CONNECTION_QUALITY: ConnectionQuality = {
  rttMs: null,
  jitterMs: null,
  packetLoss: null,
  sampledAt: null
}

export type QualityTier = 'good' | 'fair' | 'poor' | 'unknown'

/** Conservative VoIP rules of thumb; worst metric wins. */
export function classifyQuality(q: ConnectionQuality): QualityTier {
  const { rttMs, jitterMs, packetLoss } = q
  if (rttMs == null && jitterMs == null && packetLoss == null) return 'unknown'
  const poor = (rttMs ?? 0) > 250 || (packetLoss ?? 0) > 0.05 || (jitterMs ?? 0) > 50
  if (poor) return 'poor'
  const fair = (rttMs ?? 0) > 120 || (packetLoss ?? 0) > 0.01 || (jitterMs ?? 0) > 30
  return fair ? 'fair' : 'good'
}

export const QUALITY_TIER_LABEL: Record<QualityTier, string> = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  unknown: 'Unknown'
}

export function fmtMs(v: number | null | undefined): string {
  return v == null || Number.isNaN(v) ? '—' : `${Math.round(v)} ms`
}

export function fmtLoss(v: number | null | undefined): string {
  return v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(1)}%`
}
