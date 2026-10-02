/**
 * SealedDeviceMessage (docs/gateway-protocol.md §12.5): HPKE base mode
 * DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM to the recipient's certified HPKE key,
 * with an inner SignWithLabel(sender MLS key, "DeviceMessage", enc ‖ payload).
 */
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core'

import { CryptoError, type DeviceId } from '../api'
import { uuidToBytes } from '../codec'
import { HkdfInfo, SignLabel } from '../constants'
import { signWithLabel, verifyWithLabel } from '../sign'
import { concatBytes, utf8 } from './bytes'
import {
  DEVICE_MESSAGE_KIND,
  type DeviceMessageKind,
  decodeDeviceMessagePlaintext,
  decodeSealedDeviceMessage,
  encodeDeviceMessagePlaintext,
  encodeSealedDeviceMessage,
} from './codec'

let suite: CipherSuite | null = null
const hpke = (): CipherSuite =>
  (suite ??= new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() }))

const info = (kind: DeviceMessageKind, recipientDeviceId: DeviceId): Uint8Array =>
  concatBytes(utf8(HkdfInfo.SEALED_DEVICE_MESSAGE), new Uint8Array([DEVICE_MESSAGE_KIND[kind]]), uuidToBytes(recipientDeviceId))

const bytes = (b: ArrayBuffer | Uint8Array): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b))

export interface SealInput {
  recipientHpkeKey: Uint8Array
  recipientDeviceId: DeviceId
  kind: DeviceMessageKind
  senderDeviceId: DeviceId
  /** The sender's MLS signature private key. */
  signatureKey: Uint8Array
  payload: Uint8Array
}

export async function sealDeviceMessage(input: SealInput): Promise<Uint8Array> {
  const s = hpke()
  const recipientPublicKey = await s.kem.deserializePublicKey(input.recipientHpkeKey.slice().buffer)
  const ctx = await s.createSenderContext({ recipientPublicKey, info: info(input.kind, input.recipientDeviceId).slice().buffer })
  const enc = bytes(ctx.enc)
  const signature = signWithLabel(input.signatureKey, SignLabel.DEVICE_MESSAGE, concatBytes(enc, input.payload))
  const plaintext = encodeDeviceMessagePlaintext({ payload: input.payload, signature })
  const ciphertext = bytes(await ctx.seal(plaintext.slice().buffer, uuidToBytes(input.senderDeviceId).slice().buffer))
  return encodeSealedDeviceMessage({ kind: input.kind, senderDeviceId: input.senderDeviceId, enc, ciphertext })
}

export interface OpenInput {
  recipientHpkePrivateKey: Uint8Array
  recipientDeviceId: DeviceId
  sealed: Uint8Array
  /**
   * The verified MLS signature key of the sender device, or null to reject. The caller checks
   * that the device belongs to the same user and has a valid chain (§12.5).
   */
  senderSignatureKey: (senderDeviceId: DeviceId, kind: DeviceMessageKind) => Promise<Uint8Array | null>
}

/** Throws CryptoError('Malformed') on any failure: decode, HPKE open, unknown sender or signature. */
export async function openDeviceMessage(input: OpenInput): Promise<{ kind: DeviceMessageKind; senderDeviceId: DeviceId; payload: Uint8Array }> {
  let m
  try {
    m = decodeSealedDeviceMessage(input.sealed)
  } catch (e) {
    throw new CryptoError('Malformed', `device message: ${(e as Error).message}`)
  }
  let plain: Uint8Array
  try {
    const s = hpke()
    const recipientKey = await s.kem.importKey('raw', input.recipientHpkePrivateKey.slice().buffer, false)
    const ctx = await s.createRecipientContext({ recipientKey, enc: m.enc.slice().buffer, info: info(m.kind, input.recipientDeviceId).slice().buffer })
    plain = bytes(await ctx.open(m.ciphertext.slice().buffer, uuidToBytes(m.senderDeviceId).slice().buffer))
  } catch {
    throw new CryptoError('Malformed', 'device message does not open for this device')
  }
  let inner
  try {
    inner = decodeDeviceMessagePlaintext(plain)
  } catch (e) {
    throw new CryptoError('Malformed', `device message plaintext: ${(e as Error).message}`)
  }
  const key = await input.senderSignatureKey(m.senderDeviceId, m.kind)
  if (key === null) throw new CryptoError('Malformed', 'unknown or untrusted sender device')
  if (!verifyWithLabel(key, SignLabel.DEVICE_MESSAGE, concatBytes(m.enc, inner.payload), inner.signature)) {
    throw new CryptoError('Malformed', 'bad device message signature')
  }
  return { kind: m.kind, senderDeviceId: m.senderDeviceId, payload: inner.payload }
}
