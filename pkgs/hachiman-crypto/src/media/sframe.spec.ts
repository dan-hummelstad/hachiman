import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { CryptoError } from '../api'
import { deriveKeyBytes, frameNonce, sframe } from './sframe'

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const random = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n))
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i)

/** HKDF from RFC 5869 over WebCrypto HMAC: an implementation apart from @noble/hashes. */
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const k = await globalThis.crypto.subtle.importKey('raw', new Uint8Array(key.length === 0 ? new Uint8Array(32) : key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, new Uint8Array(data)))
}
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  let t: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  const out: number[] = []
  for (let i = 1; out.length < length; i++) {
    t = await hmac(prk, new Uint8Array([...t, ...info, i]))
    out.push(...t)
  }
  return new Uint8Array(out.slice(0, length))
}

describe('SFrame header (RFC 9605 §4.3)', () => {
  const vectors: [bigint, bigint, string][] = [
    [0n, 0n, '00'],
    [7n, 7n, '77'],
    [8n, 8n, '880808'],
    [0n, 0xffn, '08ff'],
    [0n, 0x100n, '090100'],
    [0x12n, 0x3456n, '89123456'],
    [0xffffn, 0xffff_ffffn, '9bffffffffffff'],
    [0xffff_ffff_ffff_ffffn, 0xffff_ffff_ffff_ffffn, 'ff' + 'ff'.repeat(16)],
  ]
  it.each(vectors)('KID %s CTR %s', (kid, ctr, want) => {
    expect(hex(sframe.encodeHeader(kid, ctr))).toBe(want)
    expect(sframe.decodeHeader(unhex(want + 'abcd'), 0)).toEqual({ kid, ctr, length: want.length / 2 })
    expect(sframe.decodeHeader(unhex('aa' + want), 1)).toEqual({ kid, ctr, length: want.length / 2 })
  })

  it('rejects truncated and non-minimal headers and out-of-range values', () => {
    for (const bad of ['', '88', '8808', '8007', '880800', '9000ff00']) expect(() => sframe.decodeHeader(unhex(bad), 0)).toThrow(CryptoError)
    expect(() => sframe.encodeHeader(-1n, 0n)).toThrow(CryptoError)
    expect(() => sframe.encodeHeader(0n, 1n << 64n)).toThrow(CryptoError)
  })

  it('packs the KID as (2 * leaf + track) << 4 | epoch & 0xF', () => {
    expect(sframe.packKid(0, 0, 0)).toBe(0n)
    expect(sframe.packKid(3, 1, 18)).toBe(0x72n)
    expect(sframe.packKid(0xffff_ffff, 1, 15)).toBe(((0xffff_ffffn * 2n + 1n) << 4n) | 15n)
    expect(sframe.unpackKid(0x72n)).toEqual({ leafIndex: 3, track: 1, epochBits: 2 })
    expect(sframe.packKid(5, 0, 16)).toBe(sframe.packKid(5, 0, 0))
    expect(sframe.packKid(5, 0, 1)).not.toBe(sframe.packKid(5, 1, 1))
    expect(() => sframe.unpackKid(1n << 63n)).toThrow(CryptoError)
  })
})

describe('SFrame key schedule (§12.10.2)', () => {
  it('matches the pinned vector and an independent HKDF', async () => {
    const kid = sframe.packKid(3, 1, 18)
    const { key, salt } = deriveKeyBytes(SECRET, 7, kid)
    expect(hex(key)).toBe('85f47e0f1d96eee9e0be6e7e265ece9d')
    expect(hex(salt)).toBe('5eb7e9a4f77e92ca07a29ef1')

    const baseKey = await hkdfExpand(SECRET, unhex('00000007'), 32)
    const secret = await hmac(new Uint8Array(0), baseKey)
    const tail = unhex('0000000000000072' + '0004')
    expect(hex(await hkdfExpand(secret, new Uint8Array([...new TextEncoder().encode('SFrame 1.0 Secret key '), ...tail]), 16))).toBe(hex(key))
    expect(hex(await hkdfExpand(secret, new Uint8Array([...new TextEncoder().encode('SFrame 1.0 Secret salt '), ...tail]), 12))).toBe(hex(salt))
  })

  it('gives every media index and every epoch its own key', () => {
    const k = (leaf: number, track: 0 | 1, epoch: number, secret: Uint8Array = SECRET): string => hex(deriveKeyBytes(secret, leaf * 2 + track, sframe.packKid(leaf, track, epoch)).key)
    const keys = new Set([k(0, 0, 1), k(0, 1, 1), k(1, 0, 1), k(1, 1, 1), k(0, 0, 2)])
    expect(keys.size).toBe(5)
    // KID repeats every 16 epochs, the key does not (a new exporter secret).
    expect(k(0, 0, 17, random(32))).not.toBe(k(0, 0, 1))
    expect(() => deriveKeyBytes(SECRET, 2, sframe.packKid(0, 0, 0))).toThrow(CryptoError)
  })

  it('gives screen audio (leaf + 2^32, uint64 info) a key of its own', async () => {
    const off = 2 ** 32
    const kid = sframe.packKid(off + 3, 0, 1)
    expect(sframe.unpackKid(kid)).toEqual({ leafIndex: off + 3, track: 0, epochBits: 1 })
    expect(() => sframe.packKid(2 * off, 0, 0)).toThrow(CryptoError)
    const m = (off + 3) * 2
    const { key } = deriveKeyBytes(SECRET, m, kid)
    // The info is uint64(m): with uint32 it would wrap to the mic's media index 6.
    const baseKey = await hkdfExpand(SECRET, unhex('0000000200000006'), 32)
    const secret = await hmac(new Uint8Array(0), baseKey)
    const tail = new Uint8Array(10)
    new DataView(tail.buffer).setBigUint64(0, kid)
    tail[9] = 4
    expect(hex(await hkdfExpand(secret, new Uint8Array([...new TextEncoder().encode('SFrame 1.0 Secret key '), ...tail]), 16))).toBe(hex(key))
    expect(hex(key)).not.toBe(hex(deriveKeyBytes(SECRET, 6, sframe.packKid(3, 0, 1)).key))
  })

  it('XORs the CTR into the low bytes of the salt', () => {
    const salt = unhex('000102030405060708090a0b')
    expect(hex(frameNonce(salt, 0n))).toBe('000102030405060708090a0b')
    expect(hex(frameNonce(salt, 0x0102n))).toBe('000102030405060708090b09')
    expect(hex(frameNonce(salt, 0xffff_ffff_ffff_ffffn))).toBe('00010203fbfaf9f8f7f6f5f4')
  })
})

describe('SFrame frames', () => {
  const kid = sframe.packKid(2, 0, 5)

  async function key(k = kid) {
    const u = sframe.unpackKid(k)
    return sframe.deriveKey(SECRET, u.leafIndex * 2 + u.track, k)
  }

  it('uses the codec clear prefix', () => {
    expect(sframe.clearPrefixLength('opus', unhex('00'))).toBe(0)
    expect(sframe.clearPrefixLength('vp8', unhex('10'))).toBe(10)
    expect(sframe.clearPrefixLength('vp8', unhex('11'))).toBe(1)
  })

  const cases: [string, 'opus' | 'vp8', Uint8Array][] = [
    ['opus', 'opus', random(120)],
    ['vp8 key frame', 'vp8', Uint8Array.from([0x10, ...random(400)])],
    ['vp8 delta frame', 'vp8', Uint8Array.from([0x31, ...random(80)])],
    ['opus, one byte', 'opus', random(1)],
  ]
  it.each(cases)('round trip: %s', async (_name, codec, frame) => {
    const k = await key()
    const ctr = 0x1234n
    const out = await sframe.encryptFrame({ frame, codec, kid, ctr, ...k })
    const p = sframe.clearPrefixLength(codec, frame)
    const header = sframe.encodeHeader(kid, ctr)
    expect(out.length).toBe(frame.length + header.length + 16)
    expect(hex(out.subarray(0, p))).toBe(hex(frame.subarray(0, p)))
    expect(hex(out.subarray(p, p + header.length))).toBe(hex(header))
    const r = await sframe.decryptFrame({ frame: out, codec, keyFor: (x) => Promise.resolve(x === kid ? k : null) })
    expect(r).toEqual({ frame, kid, ctr })
  })

  it('authenticates the clear prefix, the header and the ciphertext', async () => {
    const k = await key()
    const frame = Uint8Array.from([0x10, ...random(200)])
    const out = await sframe.encryptFrame({ frame, codec: 'vp8', kid, ctr: 9n, ...k })
    // Prefix byte, CTR byte of the header, ciphertext, tag.
    for (const i of [4, 12, 14, out.length - 1]) {
      const bad = out.slice()
      bad[i]! ^= 0x40
      expect(await sframe.decryptFrame({ frame: bad, codec: 'vp8', keyFor: () => Promise.resolve(k) })).toEqual({ failure: 'auth' })
    }
    const delta = await sframe.encryptFrame({ frame: Uint8Array.from([0x01, ...random(50)]), codec: 'vp8', kid, ctr: 10n, ...k })
    delta[0]! ^= 0x02
    expect(await sframe.decryptFrame({ frame: delta, codec: 'vp8', keyFor: () => Promise.resolve(k) })).toEqual({ failure: 'auth' })
  })

  it('leaves no plaintext after the clear prefix (forwarded payloads differ from the plaintext)', async () => {
    const k = await key()
    for (const [codec, frame] of [
      ['opus', random(1000)],
      ['vp8', Uint8Array.from([0x00, ...random(3000)])],
    ] as const) {
      const out = await sframe.encryptFrame({ frame, codec, kid, ctr: 77n, ...k })
      const p = sframe.clearPrefixLength(codec, frame)
      const windows = new Set<string>()
      for (let i = p; i + 8 <= frame.length; i++) windows.add(hex(frame.subarray(i, i + 8)))
      const wire = out.subarray(p)
      for (let i = 0; i + 8 <= wire.length; i++) expect(windows.has(hex(wire.subarray(i, i + 8)))).toBe(false)
    }
  })

  it('reports an unknown key, a wrong key and malformed frames', async () => {
    const k = await key()
    const other = await sframe.deriveKey(random(32), 4, kid)
    const out = await sframe.encryptFrame({ frame: random(40), codec: 'opus', kid, ctr: 1n, ...k })
    expect(await sframe.decryptFrame({ frame: out, codec: 'opus', keyFor: () => Promise.resolve(null) })).toEqual({ failure: 'unknown_key' })
    expect(await sframe.decryptFrame({ frame: out, codec: 'opus', keyFor: () => Promise.resolve(other) })).toEqual({ failure: 'auth' })
    expect(await sframe.decryptFrame({ frame: out.subarray(0, 10), codec: 'opus', keyFor: () => Promise.resolve(k) })).toEqual({ failure: 'malformed' })
    expect(await sframe.decryptFrame({ frame: new Uint8Array(0), codec: 'vp8', keyFor: () => Promise.resolve(k) })).toEqual({ failure: 'malformed' })
    await expect(sframe.encryptFrame({ frame: Uint8Array.from([0x00, 1, 2, 3]), codec: 'vp8', kid, ctr: 2n, ...k })).rejects.toThrow(CryptoError)
    await expect(sframe.encryptFrame({ frame: new Uint8Array(0), codec: 'opus', kid, ctr: 2n, ...k })).rejects.toThrow(CryptoError)
  })

  it('fuzz: decodeHeader throws only CryptoError, decryptFrame never throws', async () => {
    const k = await key()
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 40 }), fc.nat({ max: 40 }), (bytes, offset) => {
        try {
          const h = sframe.decodeHeader(bytes, offset)
          expect(h.length).toBeGreaterThan(0)
        } catch (e) {
          expect(e).toBeInstanceOf(CryptoError)
        }
      }),
      { numRuns: 5000 },
    )
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), fc.constantFrom('opus' as const, 'vp8' as const), fc.boolean(), async (bytes, codec, withKey) => {
        const r = await sframe.decryptFrame({ frame: bytes, codec, keyFor: () => Promise.resolve((withKey ? k : null)) })
        expect('failure' in r).toBe(true)
      }),
      { numRuns: 1000 },
    )
  })
})
