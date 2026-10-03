import { sha256 } from '@noble/hashes/sha2.js'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { CryptoError } from '../api'
import { attachments, blobLayout, encryptPadded, padme } from './index'

const SEG = 65_536
const TAG = 16
const HDR = 13

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let off = 0; off < n; off += 65_536) crypto.getRandomValues(out.subarray(off, Math.min(n, off + 65_536)))
  return out
}

/** Fast byte comparison: toEqual walks megabytes element by element. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer())
}

async function expectMalformed(p: Promise<unknown>): Promise<void> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(CryptoError)
    expect((e as CryptoError).code).toBe('Malformed')
    return
  }
  throw new Error('expected CryptoError(Malformed)')
}

/** Decrypts a tampered blob with a recomputed hash, so the AEAD and layout checks run. */
function decryptTampered(b: Uint8Array, key: Uint8Array, size: number): Promise<Blob> {
  return attachments.decrypt(new Blob([new Uint8Array(b)]), key, sha256(b), size, 'application/octet-stream')
}

describe('Padmé', () => {
  it('matches the table', () => {
    const table: [number, number][] = [
      [0, 0],
      [1, 1],
      [2, 2],
      [9, 10],
      [100, 104],
      [1000, 1024],
      [65_535, 65_536],
      [65_536, 65_536],
      [1_000_000, 1_015_808],
      [25 * 1024 * 1024, 25 * 1024 * 1024],
    ]
    for (const [l, p] of table) expect(padme(l), `Padmé(${l})`).toBe(p)
    expect(attachments.padme(9)).toBe(10)
  })

  it('never shrinks and leaks at most about 12 % (fuzz)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 40 }), (l) => {
        const p = padme(l)
        expect(p).toBeGreaterThanOrEqual(l)
        expect(p - l).toBeLessThanOrEqual(Math.max(1, l * 0.12))
        expect(padme(p)).toBe(p)
      }),
    )
  })
})

describe('attachment blobs', () => {
  for (const size of [0, 1, 65_535, 65_536, 65_537, 3 * 1024 * 1024]) {
    it(`round-trips ${size} bytes with the §12.9 layout`, async () => {
      const plain = randomBytes(size)
      const key = attachments.generateKey()
      const { blob, sha256: digest } = await attachments.encrypt(new Blob([new Uint8Array(plain)]), key)
      const layout = blobLayout(size)
      expect(blob.size).toBe(layout.blobSize)
      expect(blob.size).toBe(HDR + padme(size + 1) + TAG * Math.ceil(padme(size + 1) / SEG))
      const raw = await blobBytes(blob)
      expect(new TextDecoder().decode(raw.subarray(0, 4))).toBe('HAT1')
      expect(raw[4]).toBe(1)
      expect(raw[5]).toBe(16)
      expect(sameBytes(digest, sha256(raw))).toBe(true)
      const out = await attachments.decrypt(blob, key, digest, size, 'image/png')
      expect(out.type).toBe('image/png')
      expect(sameBytes(await blobBytes(out), plain)).toBe(true)
    })
  }

  it('uses a fresh nonce prefix per blob', async () => {
    const key = attachments.generateKey()
    const a = await blobBytes((await attachments.encrypt(new Blob(['x']), key)).blob)
    const b = await blobBytes((await attachments.encrypt(new Blob(['x']), key)).blob)
    expect(a.subarray(6, 13)).not.toEqual(b.subarray(6, 13))
  })

  it('rejects a wrong key, a wrong hash, a wrong size and a wrong key length', async () => {
    const plain = randomBytes(1000)
    const key = attachments.generateKey()
    const { blob, sha256: digest } = await attachments.encrypt(new Blob([new Uint8Array(plain)]), key)
    await expectMalformed(attachments.decrypt(blob, attachments.generateKey(), digest, 1000, 'x/y'))
    const badHash = digest.slice()
    badHash[0]! ^= 1
    await expectMalformed(attachments.decrypt(blob, key, badHash, 1000, 'x/y'))
    await expectMalformed(attachments.decrypt(blob, key, digest, 2000, 'x/y'))
    await expectMalformed(attachments.decrypt(blob, key, digest, -1, 'x/y'))
    await expectMalformed(attachments.decrypt(blob, key.slice(0, 16), digest, 1000, 'x/y'))
    await expectMalformed(attachments.decrypt(blob, key, digest.slice(0, 31), 1000, 'x/y'))
  })

  it('rejects a size mismatch inside the same Padmé bucket (padding check)', async () => {
    // Padmé(101) = Padmé(102) = 104: the blob length is the same, the padding is not.
    const key = attachments.generateKey()
    const plain = randomBytes(101)
    plain[100] = 0x80
    const { blob, sha256: digest } = await attachments.encrypt(new Blob([new Uint8Array(plain)]), key)
    expect(blobLayout(100).blobSize).toBe(blob.size)
    await expectMalformed(attachments.decrypt(blob, key, digest, 100, 'x/y'))
    expect(blobLayout(102).blobSize).toBe(blob.size)
    await expectMalformed(attachments.decrypt(blob, key, digest, 102, 'x/y'))
  })

  it('rejects truncation and extension, with a matching hash', async () => {
    const size = 3 * SEG + 10
    const key = attachments.generateKey()
    const raw = await blobBytes((await attachments.encrypt(new Blob([new Uint8Array(randomBytes(size))]), key)).blob)
    await expectMalformed(decryptTampered(raw.subarray(0, raw.length - 1), key, size))
    // Drop the final segment: the length then fits a smaller size, but no segment there carries last = 1.
    const lastStart = HDR + 3 * (SEG + TAG)
    const dropped = raw.subarray(0, lastStart)
    const droppedSize = 3 * SEG - 1
    expect(blobLayout(droppedSize).blobSize).toBe(dropped.length)
    await expectMalformed(decryptTampered(dropped, key, droppedSize))
    const extended = new Uint8Array(raw.length + TAG + 1)
    extended.set(raw)
    await expectMalformed(decryptTampered(extended, key, size))
  })

  it('rejects swapped segments', async () => {
    const size = 3 * SEG + 10
    const key = attachments.generateKey()
    const raw = await blobBytes((await attachments.encrypt(new Blob([new Uint8Array(randomBytes(size))]), key)).blob)
    const swapped = raw.slice()
    const s0 = raw.subarray(HDR, HDR + SEG + TAG)
    const s1 = raw.subarray(HDR + SEG + TAG, HDR + 2 * (SEG + TAG))
    swapped.set(s1, HDR)
    swapped.set(s0, HDR + SEG + TAG)
    await expectMalformed(decryptTampered(swapped, key, size))
  })

  it('rejects a missing last flag and a last flag on an inner segment', async () => {
    const key = attachments.generateKey()
    const crafted = async (lastOn: (i: number, n: number) => boolean): Promise<Uint8Array> => {
      // Build a 2-segment blob of P (size = 65536 → P = 65536 + 1 → Padmé(65537) bytes) with chosen last flags.
      const size = SEG
      const { paddedLength, segments } = blobLayout(size)
      const p = new Uint8Array(paddedLength)
      p.set(randomBytes(size))
      p[size] = 0x80
      const prefix = randomBytes(7)
      const header = new Uint8Array([0x48, 0x41, 0x54, 0x31, 1, 16, ...prefix])
      const k = await crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, ['encrypt'])
      const parts: Uint8Array[] = [header]
      for (let i = 0; i < segments; i++) {
        const iv = new Uint8Array(12)
        iv.set(prefix)
        new DataView(iv.buffer).setUint32(7, i)
        iv[11] = lastOn(i, segments) ? 1 : 0
        parts.push(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, k, p.subarray(i * SEG, Math.min(paddedLength, (i + 1) * SEG)))))
      }
      const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0))
      let o = 0
      for (const x of parts) {
        out.set(x, o)
        o += x.length
      }
      return out
    }
    const good = await crafted((i, n) => i === n - 1)
    expect(await blobBytes(await decryptTampered(good, key, SEG))).toHaveLength(SEG)
    await expectMalformed(decryptTampered(await crafted(() => false), key, SEG))
    await expectMalformed(decryptTampered(await crafted(() => true), key, SEG))
    await expectMalformed(decryptTampered(await crafted((i) => i === 0), key, SEG))
  })

  it('rejects bad padding under a valid AEAD', async () => {
    const key = attachments.generateKey()
    const size = 5
    const { paddedLength } = blobLayout(size)
    expect(paddedLength).toBe(6)
    for (const pad of [0x00, 0x81, 0x7f]) {
      const { blob, sha256: digest } = await encryptPadded(paddedLength, (s, e) => Promise.resolve(new Uint8Array([1, 2, 3, 4, 5, pad]).subarray(s, e)), key)
      await expectMalformed(attachments.decrypt(blob, key, digest, size, 'x/y'))
    }
    // Size 100: P = Padmé(101) = 104 bytes = file ‖ 0x80 ‖ 3 zero bytes. A non-zero pad byte fails.
    expect(blobLayout(100).paddedLength).toBe(104)
    const file = randomBytes(100)
    const withPad = (tail: number[]) => {
      const p = new Uint8Array(104)
      p.set(file)
      p.set([0x80, ...tail], 100)
      return (s: number, e: number) => Promise.resolve(p.subarray(s, e))
    }
    const bad = await encryptPadded(104, withPad([0, 1, 0]), key)
    await expectMalformed(attachments.decrypt(bad.blob, key, bad.sha256, 100, 'x/y'))
    const ok = await encryptPadded(104, withPad([0, 0, 0]), key)
    expect(await blobBytes(await attachments.decrypt(ok.blob, key, ok.sha256, 100, 'x/y'))).toEqual(file)
  })

  it('rejects a bad header (magic, version, segment size)', async () => {
    const key = attachments.generateKey()
    const raw = await blobBytes((await attachments.encrypt(new Blob(['hello']), key)).blob)
    for (const [i, v] of [
      [0, 0x49],
      [4, 2],
      [5, 15],
    ] as const) {
      const t = raw.slice()
      t[i] = v
      await expectMalformed(decryptTampered(t, key, 5))
    }
  })

  it('fuzz: the decrypt parser rejects every mutation with CryptoError', async () => {
    const key = attachments.generateKey()
    const size = SEG + 100
    const raw = await blobBytes((await attachments.encrypt(new Blob([new Uint8Array(randomBytes(size))]), key)).blob)
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.nat(raw.length - 1), fc.integer({ min: 1, max: 255 })), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: -40, max: 40 }),
        fc.boolean(),
        async (edits, sizeDelta, keepHash) => {
          const m = raw.slice()
          for (const [i, x] of edits) m[i]! ^= x
          const claimed = Math.max(0, size + sizeDelta)
          const digest = keepHash ? sha256(raw) : sha256(m)
          await expectMalformed(attachments.decrypt(new Blob([m]), key, digest, claimed, 'x/y'))
        },
      ),
      { numRuns: 200 },
    )
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), fc.nat(300), async (b, claimed) => {
        await expectMalformed(attachments.decrypt(new Blob([new Uint8Array(b)]), key, sha256(b), claimed, 'x/y'))
      }),
      { numRuns: 300 },
    )
  })
})
