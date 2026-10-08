/**
 * SFrame (RFC 9605) for voice, video and screen share (docs/gateway-protocol.md §12.10.2).
 *
 * Suite AES_128_GCM_SHA256_128 with the full 16-byte tag. The per-sender key schedule comes from
 * the MLS exporter: base_key(m) = HKDF-Expand(sframe_epoch_secret, uint32(m), 32), then the
 * RFC 9605 §4.4.2 key and salt. Frame on the wire: clear prefix ‖ header ‖ ciphertext ‖ tag,
 * AAD = header ‖ clear prefix.
 */
import { expand, extract } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { CryptoError, type SFrameModule } from '../api'
import { OPUS_PREFIX, SFRAME_CIPHER_SUITE, SFRAME_EPOCH_BITS, SFRAME_SCREEN_AUDIO_LEAF_OFFSET, VP8_DELTA_PREFIX, VP8_KEYFRAME_PREFIX } from '../constants'
import { concatBytes, utf8 } from '../identity/bytes'

const TAG_LENGTH = 16
const KEY_LENGTH = 16
const SALT_LENGTH = 12
const BASE_KEY_LENGTH = 32
const MAX_U64 = 0xffff_ffff_ffff_ffffn
const EPOCH_MASK = (1 << SFRAME_EPOCH_BITS) - 1
/**
 * The largest leaf in a KID: a real leaf (uint32) plus SFRAME_SCREEN_AUDIO_LEAF_OFFSET for screen
 * audio. Its media index (below 2^34) shifted by the epoch bits fits in 64 bits.
 */
const MAX_KID_LEAF = SFRAME_SCREEN_AUDIO_LEAF_OFFSET * 2 - 1
const MAX_MEDIA_INDEX = MAX_KID_LEAF * 2 + 1
const KEY_LABEL = utf8('SFrame 1.0 Secret key ')
const SALT_LABEL = utf8('SFrame 1.0 Secret salt ')

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n)
  return b
}

function u64(n: bigint): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n)
  return b
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n >>> 8, n & 0xff])
}

/** WebCrypto wants an ArrayBuffer-backed view. */
function ab(b: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b)
}

/** Minimal big-endian bytes of a value above 7 (1 to 8 bytes). */
function minimalBytes(v: bigint): Uint8Array {
  let n = 1
  while (n < 8 && v >> BigInt(8 * n) !== 0n) n++
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[n - 1 - i] = Number((v >> BigInt(8 * i)) & 0xffn)
  return out
}

function checkU64(v: bigint, what: string): void {
  if (typeof v !== 'bigint' || v < 0n || v > MAX_U64) throw new CryptoError('Malformed', `${what} out of range`)
}

/** RFC 9605 §4.3: |X|K(3)|Y|C(3)|, then the KID bytes (X = 1), then the CTR bytes (Y = 1). */
function encodeHeader(kid: bigint, ctr: bigint): Uint8Array {
  checkU64(kid, 'KID')
  checkU64(ctr, 'CTR')
  let config = 0
  const parts: Uint8Array[] = []
  if (kid < 8n) config |= Number(kid) << 4
  else {
    const k = minimalBytes(kid)
    config |= 0x80 | ((k.length - 1) << 4)
    parts.push(k)
  }
  if (ctr < 8n) config |= Number(ctr)
  else {
    const c = minimalBytes(ctr)
    config |= 0x08 | (c.length - 1)
    parts.push(c)
  }
  return concatBytes(new Uint8Array([config]), ...parts)
}

function readValue(frame: Uint8Array, offset: number, length: number, what: string): bigint {
  if (offset + length > frame.length) throw new CryptoError('Malformed', `SFrame header: short ${what}`)
  let v = 0n
  for (let i = 0; i < length; i++) v = (v << 8n) | BigInt(frame[offset + i]!)
  // One encoding per value: an extended field holds a value above 7 in minimal bytes.
  if (v < 8n || (length > 1 && frame[offset] === 0)) throw new CryptoError('Malformed', `SFrame header: non-minimal ${what}`)
  return v
}

function decodeHeader(frame: Uint8Array, offset: number): { kid: bigint; ctr: bigint; length: number } {
  if (!(frame instanceof Uint8Array) || !Number.isInteger(offset) || offset < 0 || offset >= frame.length) {
    throw new CryptoError('Malformed', 'SFrame header: no config byte')
  }
  const config = frame[offset]!
  let pos = offset + 1
  let kid: bigint
  if (config & 0x80) {
    const n = ((config >> 4) & 0x07) + 1
    kid = readValue(frame, pos, n, 'KID')
    pos += n
  } else kid = BigInt((config >> 4) & 0x07)
  let ctr: bigint
  if (config & 0x08) {
    const n = (config & 0x07) + 1
    ctr = readValue(frame, pos, n, 'CTR')
    pos += n
  } else ctr = BigInt(config & 0x07)
  return { kid, ctr, length: pos - offset }
}

function packKid(leafIndex: number, track: 0 | 1, epoch: number): bigint {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex > MAX_KID_LEAF) throw new CryptoError('Malformed', 'leaf index out of range')
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime input from another Worker
  if (track !== 0 && track !== 1) throw new CryptoError('Malformed', 'track must be 0 or 1')
  if (!Number.isInteger(epoch) || epoch < 0) throw new CryptoError('Malformed', 'epoch out of range')
  const m = BigInt(leafIndex) * 2n + BigInt(track)
  return (m << BigInt(SFRAME_EPOCH_BITS)) | BigInt(epoch & EPOCH_MASK)
}

function unpackKid(kid: bigint): { leafIndex: number; track: 0 | 1; epochBits: number } {
  checkU64(kid, 'KID')
  const m = kid >> BigInt(SFRAME_EPOCH_BITS)
  if (m > BigInt(MAX_MEDIA_INDEX)) throw new CryptoError('Malformed', 'KID leaf out of range')
  return { leafIndex: Number(m >> 1n), track: Number(m & 1n) as 0 | 1, epochBits: Number(kid & BigInt(EPOCH_MASK)) }
}

/** The raw key and salt (pure, synchronous): pinned by the key-derivation vector test. */
export function deriveKeyBytes(epochSecret: Uint8Array, mediaIndex: number, kid: bigint): { key: Uint8Array; salt: Uint8Array } {
  if (epochSecret.length !== BASE_KEY_LENGTH) throw new CryptoError('Malformed', `sframe_epoch_secret must be ${BASE_KEY_LENGTH} bytes`)
  if (!Number.isInteger(mediaIndex) || mediaIndex < 0 || mediaIndex > MAX_MEDIA_INDEX) throw new CryptoError('Malformed', 'media index out of range')
  checkU64(kid, 'KID')
  if (kid >> BigInt(SFRAME_EPOCH_BITS) !== BigInt(mediaIndex)) throw new CryptoError('Malformed', 'KID does not carry this media index')
  // uint32 for the mic and video of real leaves (unchanged); uint64 from 2^32, so screen audio
  // never shares the info bytes of another media index.
  const info = mediaIndex < 2 ** 32 ? u32(mediaIndex) : u64(BigInt(mediaIndex))
  const baseKey = expand(sha256, epochSecret, info, BASE_KEY_LENGTH)
  const secret = extract(sha256, baseKey, new Uint8Array(0))
  const tail = concatBytes(u64(kid), u16(SFRAME_CIPHER_SUITE))
  return {
    key: expand(sha256, secret, concatBytes(KEY_LABEL, tail), KEY_LENGTH),
    salt: expand(sha256, secret, concatBytes(SALT_LABEL, tail), SALT_LENGTH),
  }
}

/** nonce = salt XOR uint96(CTR). */
export function frameNonce(salt: Uint8Array, ctr: bigint): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(salt)
  for (let i = 0; i < 8; i++) nonce[SALT_LENGTH - 1 - i]! ^= Number((ctr >> BigInt(8 * i)) & 0xffn)
  return nonce
}

function clearPrefixLength(codec: 'opus' | 'vp8', frame: Uint8Array): number {
  if (codec === 'opus') return OPUS_PREFIX
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime input from another Worker
  if (codec !== 'vp8') throw new CryptoError('Unsupported', `codec ${String(codec)}`)
  // VP8 payload descriptor stripped: bit 0 of the first byte is 0 for a key frame (RFC 6386 §9.1).
  return frame.length > 0 && (frame[0]! & 0x01) === 0 ? VP8_KEYFRAME_PREFIX : VP8_DELTA_PREFIX
}

export const sframe: SFrameModule = {
  packKid,
  unpackKid,
  encodeHeader,
  decodeHeader,

  async deriveKey(epochSecret, mediaIndex, kid) {
    const { key, salt } = deriveKeyBytes(epochSecret, mediaIndex, kid)
    const raw = ab(key)
    key.fill(0)
    const cryptoKey = await globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    raw.fill(0)
    return { key: cryptoKey, salt }
  },

  clearPrefixLength,

  async encryptFrame({ frame, codec, kid, ctr, key, salt }) {
    const p = clearPrefixLength(codec, frame)
    if (frame.length < p + 1) throw new CryptoError('Malformed', 'frame shorter than its clear prefix + 1')
    if (salt.length !== SALT_LENGTH) throw new CryptoError('Malformed', 'salt must be 12 bytes')
    const header = encodeHeader(kid, ctr)
    const prefix = frame.subarray(0, p)
    const params = { name: 'AES-GCM', iv: frameNonce(salt, ctr), additionalData: ab(concatBytes(header, prefix)), tagLength: TAG_LENGTH * 8 }
    const sealed = new Uint8Array(await globalThis.crypto.subtle.encrypt(params, key, ab(frame.subarray(p))))
    return concatBytes(prefix, header, sealed)
  },

  async decryptFrame({ frame, codec, keyFor }) {
    let p: number
    let h: { kid: bigint; ctr: bigint; length: number }
    try {
      p = clearPrefixLength(codec, frame)
      h = decodeHeader(frame, p)
    } catch {
      return { failure: 'malformed' }
    }
    const body = frame.subarray(p + h.length)
    if (body.length < TAG_LENGTH + 1) return { failure: 'malformed' }
    let k: { key: CryptoKey; salt: Uint8Array } | null
    try {
      k = await keyFor(h.kid)
    } catch {
      k = null
    }
    if (k === null) return { failure: 'unknown_key' }
    if (k.salt.length !== SALT_LENGTH) return { failure: 'unknown_key' }
    const prefix = frame.subarray(0, p)
    const header = frame.subarray(p, p + h.length)
    const params = { name: 'AES-GCM', iv: frameNonce(k.salt, h.ctr), additionalData: ab(concatBytes(header, prefix)), tagLength: TAG_LENGTH * 8 }
    let plain: Uint8Array
    try {
      plain = new Uint8Array(await globalThis.crypto.subtle.decrypt(params, k.key, ab(body)))
    } catch {
      return { failure: 'auth' }
    }
    return { frame: concatBytes(prefix, plain), kid: h.kid, ctr: h.ctr }
  },
}
