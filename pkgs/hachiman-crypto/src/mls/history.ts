/**
 * History bundles (docs/gateway-protocol.md §12.11.2). K_hist is the history exporter of the
 * bundle epoch. Every bundle has a random 12-byte nonce under a key that is unique per
 * (group, epoch), and one sender seals at most a few bundles per epoch, so a nonce never repeats.
 */
import { gcm } from '@noble/ciphers/aes.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { CryptoError, type DeviceId, type HistoryKeyEntry } from '../api'
import { CodecError, Reader, Writer, bytesToUuid, decode, encode, uuidToBytes } from '../codec'
import { EXPORTER_LENGTH, HISTORY_BUNDLE_MAX_BYTES, HISTORY_BUNDLE_MAX_EPOCHS, SignLabel, WIRE_VERSION } from '../constants'
import { concatBytes, equalBytes, randomBytes } from '../identity/bytes'
import { signWithLabel, verifyWithLabel } from '../sign'

const NONCE_LENGTH = 12

export interface HistoryBundleHeader {
  groupId: Uint8Array
  epoch: number
  senderLeaf: number
  senderDeviceId: DeviceId
  nonce: Uint8Array
}

function writeHeader(w: Writer, h: HistoryBundleHeader): Writer {
  return w.u8(WIRE_VERSION).opaque(h.groupId).u64(h.epoch).u32(h.senderLeaf).fixed(uuidToBytes(h.senderDeviceId), 16).fixed(h.nonce, NONCE_LENGTH)
}

function encodeKeys(keys: readonly { epoch: number; secret: Uint8Array }[]): Uint8Array {
  return encode((w) => w.vector(keys, (x, k) => x.u64(k.epoch).fixed(k.secret, EXPORTER_LENGTH)))
}

function readKeys(r: Reader): { epoch: number; secret: Uint8Array }[] {
  return r.vector((x) => ({ epoch: x.u64n(), secret: x.fixed(EXPORTER_LENGTH) }), HISTORY_BUNDLE_MAX_EPOCHS)
}

const signedContent = (aad: Uint8Array, keys: Uint8Array): Uint8Array => concatBytes(sha256(aad), sha256(keys))

/** Picks the most recent epochs below the bundle epoch, ascending, at most HISTORY_BUNDLE_MAX_EPOCHS. */
export function selectBundleKeys(groupId: Uint8Array, bundleEpoch: number, entries: readonly HistoryKeyEntry[]): { epoch: number; secret: Uint8Array }[] {
  const byEpoch = new Map<number, Uint8Array>()
  for (const e of entries) {
    if (!equalBytes(e.groupId, groupId)) throw new CryptoError('Malformed', 'history entry of another group')
    if (!Number.isSafeInteger(e.epoch) || e.epoch < 0 || e.epoch >= bundleEpoch) continue
    if (e.secret.length !== EXPORTER_LENGTH) throw new CryptoError('Malformed', 'history secret must be 32 bytes')
    byEpoch.set(e.epoch, e.secret)
  }
  return [...byEpoch].sort((a, b) => a[0] - b[0]).slice(-HISTORY_BUNDLE_MAX_EPOCHS).map(([epoch, secret]) => ({ epoch, secret }))
}

export function sealBundle(input: { header: Omit<HistoryBundleHeader, 'nonce'>; kHist: Uint8Array; signatureKey: Uint8Array; keys: { epoch: number; secret: Uint8Array }[] }): Uint8Array {
  if (input.kHist.length !== EXPORTER_LENGTH) throw new CryptoError('Malformed', 'K_hist must be 32 bytes')
  let keys = input.keys
  // Drop the oldest epochs until the bundle fits HISTORY_BUNDLE_MAX_BYTES.
  for (;;) {
    const header: HistoryBundleHeader = { ...input.header, nonce: randomBytes(NONCE_LENGTH) }
    const aad = encode((w) => writeHeader(w, header))
    const keyBytes = encodeKeys(keys)
    const signature = signWithLabel(input.signatureKey, SignLabel.HISTORY_BUNDLE, signedContent(aad, keyBytes))
    const plaintext = encode((w) => w.vector(keys, (x, k) => x.u64(k.epoch).fixed(k.secret, EXPORTER_LENGTH)).opaque(signature))
    const ciphertext = gcm(input.kHist, header.nonce, aad).encrypt(plaintext)
    const out = encode((w) => writeHeader(w, header).opaque(ciphertext))
    if (out.length <= HISTORY_BUNDLE_MAX_BYTES || keys.length === 0) {
      if (out.length > HISTORY_BUNDLE_MAX_BYTES) throw new CryptoError('TooLarge', 'history bundle above the limit')
      return out
    }
    keys = keys.slice(Math.ceil(keys.length / 8))
  }
}

export function decodeBundleHeader(bundle: Uint8Array): { header: HistoryBundleHeader; ciphertext: Uint8Array; aad: Uint8Array } {
  if (bundle.length > HISTORY_BUNDLE_MAX_BYTES) throw new CryptoError('TooLarge', 'history bundle above the limit')
  try {
    return decode(bundle, (r) => {
      if (r.u8() !== WIRE_VERSION) throw new CodecError('history bundle version')
      const header: HistoryBundleHeader = { groupId: r.opaque(64), epoch: r.u64n(), senderLeaf: r.u32(), senderDeviceId: bytesToUuid(r.fixed(16)), nonce: r.fixed(NONCE_LENGTH) }
      const ciphertext = r.opaque()
      return { header, ciphertext, aad: encode((w) => writeHeader(w, header)) }
    })
  } catch (e) {
    if (e instanceof CryptoError) throw e
    throw new CryptoError('Malformed', `history bundle: ${(e as Error).message}`)
  }
}

/** Decrypts and verifies. `senderKey` is the verified MLS signature key of the sender leaf. */
export function openBundle(input: { bundle: ReturnType<typeof decodeBundleHeader>; kHist: Uint8Array; senderKey: Uint8Array }): { epoch: number; secret: Uint8Array }[] {
  const { header, ciphertext, aad } = input.bundle
  let plaintext: Uint8Array
  try {
    plaintext = gcm(input.kHist, header.nonce, aad).decrypt(ciphertext)
  } catch {
    throw new CryptoError('Malformed', 'history bundle does not decrypt')
  }
  let content: { keys: { epoch: number; secret: Uint8Array }[]; signature: Uint8Array }
  try {
    content = decode(plaintext, (r) => ({ keys: readKeys(r), signature: r.opaque() }))
  } catch (e) {
    throw new CryptoError('Malformed', `history bundle content: ${(e as Error).message}`)
  }
  if (!verifyWithLabel(input.senderKey, SignLabel.HISTORY_BUNDLE, signedContent(aad, encodeKeys(content.keys)), content.signature)) {
    throw new CryptoError('Malformed', 'history bundle signature')
  }
  let prev = -1
  for (const k of content.keys) {
    if (k.epoch <= prev || k.epoch >= header.epoch) throw new CryptoError('Malformed', 'history bundle epochs must ascend below the bundle epoch')
    prev = k.epoch
  }
  return content.keys
}
