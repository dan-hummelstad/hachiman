/**
 * Attachment blobs (docs/gateway-protocol.md §12.9): AES-256-GCM STREAM in 64 KiB segments,
 * Padmé padding, incremental SHA-256 over the blob.
 *
 *   header       = "HAT1" ‖ uint8 version = 1 ‖ uint8 segment_log2 = 16 ‖ nonce_prefix[7]
 *   P            = file ‖ 0x80 ‖ 0x00 × (Padmé(L + 1) − L − 1)
 *   nonce_i      = nonce_prefix ‖ uint32(i) ‖ uint8(last)
 *   ciphertext_i = AES-256-GCM(key, nonce_i, aad = header, segment_i)
 *
 * Encrypt and decrypt read the input with Blob.slice, one segment at a time.
 */
import { sha256 } from '@noble/hashes/sha2.js'

import type { AttachmentModule } from '../api'
import { CryptoError } from '../api'
import {
  ATTACHMENT_HEADER_LENGTH,
  ATTACHMENT_MAGIC,
  ATTACHMENT_NONCE_PREFIX_LENGTH,
  ATTACHMENT_SEGMENT_SIZE,
  ATTACHMENT_TAG_LENGTH,
  WIRE_VERSION,
} from '../constants'

const SEGMENT_LOG2 = 16
const KEY_LENGTH = 32
const MAGIC = new TextEncoder().encode(ATTACHMENT_MAGIC)
/** WebCrypto AES-GCM nonces carry a uint32 segment index. */
const MAX_SEGMENTS = 0x1_0000_0000

function malformed(message: string): CryptoError {
  return new CryptoError('Malformed', message)
}

function buf(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.length)
  out.set(u)
  return out
}

/** ⌊log2 n⌋ for a safe integer n ≥ 1. */
function floorLog2(n: number): number {
  return n.toString(2).length - 1
}

/** Padmé(L) (§12.9). For L < 2 it is L. */
export function padme(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0) throw malformed('Padmé length must be a non-negative safe integer')
  if (length < 2) return length
  const e = floorLog2(length)
  const s = floorLog2(e) + 1
  const step = 2 ** (e - s)
  return Math.ceil(length / step) * step
}

/** The layout of a blob for a plaintext of `size` bytes. */
export function blobLayout(size: number): { paddedLength: number; segments: number; blobSize: number } {
  const paddedLength = padme(size + 1)
  const segments = Math.ceil(paddedLength / ATTACHMENT_SEGMENT_SIZE)
  return { paddedLength, segments, blobSize: ATTACHMENT_HEADER_LENGTH + paddedLength + ATTACHMENT_TAG_LENGTH * segments }
}

function encodeBlobHeader(noncePrefix: Uint8Array): Uint8Array {
  const h = new Uint8Array(ATTACHMENT_HEADER_LENGTH)
  h.set(MAGIC, 0)
  h[4] = WIRE_VERSION
  h[5] = SEGMENT_LOG2
  h.set(noncePrefix, 6)
  return h
}

function segmentNonce(noncePrefix: Uint8Array, index: number, last: boolean): Uint8Array<ArrayBuffer> {
  const n = new Uint8Array(12)
  n.set(noncePrefix, 0)
  new DataView(n.buffer).setUint32(ATTACHMENT_NONCE_PREFIX_LENGTH, index)
  n[11] = last ? 1 : 0
  return n
}

async function importKey(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (key.length !== KEY_LENGTH) throw malformed(`attachment key must be ${KEY_LENGTH} bytes`)
  return globalThis.crypto.subtle.importKey('raw', buf(key), 'AES-GCM', false, [usage])
}

async function readRange(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer())
}

/**
 * Encrypts the padded stream P of `paddedLength` bytes. `segment(start, end)` returns P[start, end).
 * `encrypt` is the normal entry. Tests use this to build blobs with bad padding.
 */
export async function encryptPadded(
  paddedLength: number,
  segment: (start: number, end: number) => Promise<Uint8Array>,
  key: Uint8Array,
): Promise<{ blob: Blob; sha256: Uint8Array }> {
  const segments = Math.ceil(paddedLength / ATTACHMENT_SEGMENT_SIZE)
  if (paddedLength < 1 || segments > MAX_SEGMENTS) throw malformed('attachment length out of range')
  const k = await importKey(key, 'encrypt')
  const noncePrefix = globalThis.crypto.getRandomValues(new Uint8Array(ATTACHMENT_NONCE_PREFIX_LENGTH))
  const header = encodeBlobHeader(noncePrefix)
  const aad = buf(header)
  const hash = sha256.create().update(header)
  const parts: Uint8Array<ArrayBuffer>[] = [buf(header)]
  for (let i = 0; i < segments; i++) {
    const start = i * ATTACHMENT_SEGMENT_SIZE
    const end = Math.min(start + ATTACHMENT_SEGMENT_SIZE, paddedLength)
    const plain = await segment(start, end)
    if (plain.length !== end - start) throw malformed('segment reader returned a wrong length')
    const iv = segmentNonce(noncePrefix, i, i === segments - 1)
    const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, buf(plain)))
    hash.update(ct)
    parts.push(ct)
  }
  return { blob: new Blob(parts, { type: 'application/octet-stream' }), sha256: hash.digest() }
}

async function decryptBlob(blob: Blob, key: Uint8Array, expectedSha256: Uint8Array, size: number, mime: string): Promise<Blob> {
  if (expectedSha256.length !== 32) throw malformed('sha256 must be 32 bytes')
  if (!Number.isSafeInteger(size) || size < 0) throw malformed('size must be a non-negative safe integer')
  const { paddedLength, segments, blobSize } = blobLayout(size)

  // 1. Length.
  if (blob.size !== blobSize) throw malformed(`blob has ${blob.size} bytes, expected ${blobSize}`)

  // 2. Header and SHA-256 of the whole blob.
  const header = await readRange(blob, 0, ATTACHMENT_HEADER_LENGTH)
  for (let i = 0; i < MAGIC.length; i++) if (header[i] !== MAGIC[i]) throw malformed('bad attachment magic')
  if (header[4] !== WIRE_VERSION) throw malformed('unknown attachment version')
  if (header[5] !== SEGMENT_LOG2) throw malformed('unsupported attachment segment size')
  const noncePrefix = header.slice(6, ATTACHMENT_HEADER_LENGTH)
  const hash = sha256.create().update(header)
  const step = ATTACHMENT_SEGMENT_SIZE + ATTACHMENT_TAG_LENGTH
  for (let off = ATTACHMENT_HEADER_LENGTH; off < blobSize; off += step) {
    hash.update(await readRange(blob, off, Math.min(off + step, blobSize)))
  }
  const actual = hash.digest()
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= actual[i]! ^ expectedSha256[i]!
  if (diff !== 0) throw malformed('attachment sha256 mismatch')

  // 3. Segments, then the padding: P[size] = 0x80 and every later byte is 0x00.
  const k = await importKey(key, 'decrypt')
  const aad = buf(header)
  const parts: Uint8Array<ArrayBuffer>[] = []
  for (let i = 0; i < segments; i++) {
    const pStart = i * ATTACHMENT_SEGMENT_SIZE
    const pEnd = Math.min(pStart + ATTACHMENT_SEGMENT_SIZE, paddedLength)
    const off = ATTACHMENT_HEADER_LENGTH + pStart + i * ATTACHMENT_TAG_LENGTH
    const ct = await readRange(blob, off, off + (pEnd - pStart) + ATTACHMENT_TAG_LENGTH)
    const iv = segmentNonce(noncePrefix, i, i === segments - 1)
    let plain: Uint8Array<ArrayBuffer>
    try {
      plain = new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, buf(ct)))
    } catch {
      throw malformed(`attachment segment ${i} failed to decrypt`)
    }
    for (let p = Math.max(pStart, size); p < pEnd; p++) {
      if (plain[p - pStart] !== (p === size ? 0x80 : 0x00)) throw malformed('bad attachment padding')
    }
    if (pStart < size) parts.push(plain.subarray(0, Math.min(pEnd, size) - pStart))
  }
  return new Blob(parts, { type: mime })
}

export const attachments: AttachmentModule = {
  padme,

  async encrypt(plaintext, key) {
    const size = plaintext.size
    const { paddedLength } = blobLayout(size)
    return encryptPadded(
      paddedLength,
      async (start, end) => {
        const out = new Uint8Array(end - start)
        if (start < size) out.set(await readRange(plaintext, start, Math.min(end, size)))
        if (size >= start && size < end) out[size - start] = 0x80
        return out
      },
      key,
    )
  },

  async decrypt(blob, key, expectedSha256, size, mime) {
    try {
      return await decryptBlob(blob, key, expectedSha256, size, mime)
    } catch (e) {
      if (e instanceof CryptoError) throw e
      throw malformed(`attachment: ${e instanceof Error ? e.message : String(e)}`)
    }
  },

  generateKey() {
    return globalThis.crypto.getRandomValues(new Uint8Array(KEY_LENGTH))
  },
}
