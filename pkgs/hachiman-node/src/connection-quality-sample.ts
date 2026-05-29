/**
 * A measured connection-quality sample for the client's control-channel
 * session, derived from the Mumble Ping round-trip.
 *
 * The field names and units intentionally mirror the shared UI's
 * `ConnectionQuality` type (`apps/hachiman/src/lib/connection-quality.ts`) so a
 * `connectionQuality` event payload can be handed straight to
 * `voiceStore.setConnectionQuality(...)` with no remapping. Every field is
 * nullable: `null` means "not derivable from the data seen so far" — never a
 * fabricated value.
 */
export interface ConnectionQualitySample {
  /** Round-trip time to the server, ms. Echoed-timestamp delta of the Ping. */
  rttMs: number | null;
  /**
   * Jitter, ms — mean absolute deviation of recent RTT samples. `null` until at
   * least two RTT samples have been observed.
   */
  jitterMs: number | null;
  /**
   * Fraction in [0,1] of voice packets the server reports as never received,
   * derived from the Ping `good`/`late`/`lost` counters. `null` while the
   * server has no packet accounting yet (e.g. before any voice has flowed).
   */
  packetLoss: number | null;
  /** Active voice transport, for operator context. */
  transport: 'udp' | 'webrtc' | 'tcp-tunnel' | null;
  /** ms epoch of this sample. */
  sampledAt: number | null;
}
