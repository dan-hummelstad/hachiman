/**
 * Device proof of possession (§12.12 "Device proof"). X-Hachiman-Device is only an id: the device
 * also signs each request with its MLS signature key (`devices.mls_signature_key`). The message
 * is `deviceProofMessage` of @hachiman/crypto over the method, path + query, X-Hachiman-Device-Ts,
 * X-Hachiman-Device-Nonce and SHA-256 of the body. A stolen bearer token thus cannot claim a
 * device. Takusen rejects a ts more than 5 minutes from its clock and a nonce it saw before.
 * Every failure is 401 DeviceProofInvalid.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

import type { Redis } from 'ioredis'

import { ApiError } from '@/lib/errors'

import { DEVICE_PROOF_MAX_SKEW_MS, DEVICE_PROOF_NONCE_RE, deviceProofMessage } from './crypto'

export const PROOF_TS_HEADER = 'x-hachiman-device-ts'
export const PROOF_NONCE_HEADER = 'x-hachiman-device-nonce'
export const PROOF_SIG_HEADER = 'x-hachiman-device-sig'

/** Twice the skew window: a nonce is remembered for as long as its ts can pass the window. */
export const NONCE_TTL_MS = 2 * DEVICE_PROOF_MAX_SKEW_MS

const NONCE_KEY = 'takusen:device_nonce:'

/** Remembers the nonces of each device. */
export interface NonceStore {
  /** False when the nonce was seen before (a replay). */
  claim(deviceKey: string, nonce: string): Promise<boolean>
}

export function redisNonceStore(client: Redis): NonceStore {
  return {
    async claim(deviceKey, nonce) {
      return (await client.set(`${NONCE_KEY}${deviceKey}:${nonce}`, '1', 'PX', NONCE_TTL_MS, 'NX')) === 'OK'
    },
  }
}

/** For tests. Entries do not expire. */
export class InMemoryNonceStore implements NonceStore {
  readonly seen = new Set<string>()
  async claim(deviceKey: string, nonce: string): Promise<boolean> {
    const k = `${deviceKey}:${nonce}`
    if (this.seen.has(k)) return false
    this.seen.add(k)
    return true
  }
}

/** The signed facts of one request, read before the handler reads the body. */
export interface RequestProof {
  method: string
  pathAndQuery: string
  bodySha256: Uint8Array
  ts: string | null
  nonce: string | null
  sig: string | null
}

export async function readRequestProof(req: Request): Promise<RequestProof> {
  const url = new URL(req.url)
  const body = new Uint8Array(await req.clone().arrayBuffer())
  return {
    method: req.method,
    pathAndQuery: url.pathname + url.search,
    bodySha256: new Uint8Array(createHash('sha256').update(body).digest()),
    ts: req.headers.get(PROOF_TS_HEADER),
    nonce: req.headers.get(PROOF_NONCE_HEADER),
    sig: req.headers.get(PROOF_SIG_HEADER),
  }
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]), format: 'der', type: 'spki' })
    return verify(null, message, key, signature)
  } catch {
    return false
  }
}

const invalid = (why: string) => new ApiError('DeviceProofInvalid', 401, `device proof: ${why}`)

/**
 * Checks the proof of `deviceId` ("" for POST /devices) by `publicKey`. The nonce is claimed only
 * after the signature verifies, so a forged request cannot burn a nonce of the device.
 */
export async function checkDeviceProof(
  proof: RequestProof,
  deviceId: string,
  publicKey: Uint8Array | null,
  nonces: NonceStore,
  now: Date,
): Promise<void> {
  if (proof.ts === null || proof.nonce === null || proof.sig === null) throw invalid('missing X-Hachiman-Device-Ts, -Nonce or -Sig')
  if (!/^\d{1,16}$/.test(proof.ts)) throw invalid('bad ts')
  const ts = Number(proof.ts)
  if (Math.abs(now.getTime() - ts) > DEVICE_PROOF_MAX_SKEW_MS) throw invalid('ts outside the 5 minute window')
  if (!DEVICE_PROOF_NONCE_RE.test(proof.nonce)) throw invalid('bad nonce')
  if (!/^[A-Za-z0-9_-]{86}$/.test(proof.sig)) throw invalid('bad signature encoding')
  if (!publicKey) throw invalid('the device has no MLS key')
  const message = deviceProofMessage(
    { kind: 'ds', method: proof.method, pathAndQuery: proof.pathAndQuery, bodySha256: proof.bodySha256 },
    deviceId,
    ts,
    proof.nonce,
  )
  if (!verifyEd25519(publicKey, message, new Uint8Array(Buffer.from(proof.sig, 'base64url')))) throw invalid('bad signature')
  // The key, not the id: POST /devices has no device id yet.
  if (!(await nonces.claim(Buffer.from(publicKey).toString('base64url'), proof.nonce))) throw invalid('nonce replay')
}
