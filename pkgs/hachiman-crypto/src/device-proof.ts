/**
 * Device proof of possession (docs/gateway-protocol.md §12.12 "Device proof", §12.13). The device
 * signs each DS request and each IDENTIFY/RESUME with its MLS signature key (pure Ed25519 over the
 * message below). Takusen and the gateway verify with `devices.mls_signature_key`. A bearer token
 * alone thus cannot claim a device.
 *
 * The message is UTF-8, its lines joined by "\n":
 *   ds:       DEVICE_PROOF_VERSION, "ds", deviceId, METHOD, pathAndQuery, ts, nonce, b64url(SHA-256(body))
 *   identify: DEVICE_PROOF_VERSION, "identify", deviceId, sessionId or "", ts, nonce, b64url(SHA-256(token))
 *
 * `deviceId` is "" for POST /devices (the device has no id yet). No field may hold "\n".
 */
import { toB64url } from './codec'

export const DEVICE_PROOF_VERSION = 'hachiman-device-proof/1'
/** Takusen and the gateway reject a proof whose ts is further than this from their clock. */
export const DEVICE_PROOF_MAX_SKEW_MS = 5 * 60_000
/** A nonce is 16 random bytes, base64url (22 characters). */
export const DEVICE_PROOF_NONCE_BYTES = 16
export const DEVICE_PROOF_NONCE_RE = /^[A-Za-z0-9_-]{22}$/

/** What the UI thread asks the Worker to sign. The Worker adds deviceId, ts and nonce. */
export type DeviceProofInput =
  | { kind: 'ds'; method: string; pathAndQuery: string; bodySha256: Uint8Array }
  | { kind: 'identify'; sessionId: string | null; tokenSha256: Uint8Array }

/** The headers X-Hachiman-Device-Ts / -Nonce / -Sig, or the IDENTIFY `deviceProof`. */
export interface DeviceProof {
  /** Unix milliseconds. */
  ts: number
  nonce: string
  /** Ed25519 signature, base64url. */
  sig: string
}

export function deviceProofMessage(input: DeviceProofInput, deviceId: string, ts: number, nonce: string): Uint8Array {
  const lines =
    input.kind === 'ds'
      ? [DEVICE_PROOF_VERSION, 'ds', deviceId, input.method.toUpperCase(), input.pathAndQuery, String(ts), nonce, toB64url(input.bodySha256)]
      : [DEVICE_PROOF_VERSION, 'identify', deviceId, input.sessionId ?? '', String(ts), nonce, toB64url(input.tokenSha256)]
  for (const l of lines) if (l.includes('\n')) throw new Error('device proof: a field holds a newline')
  return new TextEncoder().encode(lines.join('\n'))
}
