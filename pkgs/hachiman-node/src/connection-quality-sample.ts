/**
 * A measured connection-quality sample for the client's session. RTT comes
 * from the Mumble control-channel Ping round-trip; loss and jitter come from
 * the WebRTC voice path's RTCStats (the only voice transport this client uses).
 *
 * The field names and units intentionally mirror the shared UI's
 * `ConnectionQuality` type (`apps/hachiman/src/lib/connection-quality.ts`) so a
 * `connectionQuality` event payload can be handed straight to
 * `voiceStore.setConnectionQuality(...)` with no remapping. Every field is
 * nullable: `null` means "not derivable from the data seen so far" — never a
 * fabricated value.
 */
export interface ConnectionQualitySample {
  /**
   * Round-trip time to the server, ms. The echoed-timestamp delta of the
   * control-channel Ping (preferring the WebRTC `roundTripTime` when voice is
   * flowing).
   */
  rttMs: number | null;
  /**
   * Jitter, ms. The WebRTC inbound audio jitter when voice is flowing,
   * otherwise the mean absolute deviation of recent control-channel RTT
   * samples (`null` until at least two RTT samples have been observed).
   */
  jitterMs: number | null;
  /**
   * Fraction in [0,1] of voice packets never received, interval-differenced
   * from the WebRTC inbound audio RTP report's cumulative
   * `packetsLost`/`packetsReceived`. `null` until two samples exist, when no
   * packets flowed in the interval, or in the non-WebRTC case (this client has
   * no native-UDP voice path; the server's crypt good/late/lost counters do
   * not advance for a WebRTC client, so they cannot be used).
   */
  packetLoss: number | null;
  /** Active voice transport, for operator context. */
  transport: 'udp' | 'webrtc' | 'tcp-tunnel' | null;
  /** ms epoch of this sample. */
  sampledAt: number | null;
}
