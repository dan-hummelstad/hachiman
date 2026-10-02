import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { CodecError, Reader, Writer, bytesToUuid, decode, encode, fromB64url, toB64url, uuidToBytes } from './codec'

describe('codec', () => {
  it('round-trips varints with minimal encodings', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0x3fffffff }), (n) => {
        const bytes = encode((w) => w.varint(n))
        expect(bytes.length).toBe(n < 0x40 ? 1 : n < 0x4000 ? 2 : 4)
        expect(decode(bytes, (r) => r.varint())).toBe(n)
      }),
    )
  })

  it('rejects non-minimal varints and trailing bytes', () => {
    expect(() => decode(new Uint8Array([0x40, 0x01]), (r) => r.varint())).toThrow(CodecError)
    expect(() => decode(new Uint8Array([0x01, 0x00]), (r) => r.varint())).toThrow(CodecError)
    expect(() => decode(new Uint8Array([0xc0, 0, 0, 0, 0, 0, 0, 0]), (r) => r.varint())).toThrow(CodecError)
  })

  it('round-trips structs', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), fc.string(), fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), fc.option(fc.integer({ min: 0, max: 65535 })), (b, s, big, opt) => {
        const bytes = new Writer().opaque(b).utf8(s).u64(big).optional(opt, (w, v) => w.u16(v)).vector([1, 2, 3], (w, v) => w.u8(v)).finish()
        const r = new Reader(bytes)
        expect(r.opaque()).toEqual(b)
        expect(r.utf8()).toBe(s)
        expect(r.u64()).toBe(big)
        expect(r.optional((x) => x.u16())).toBe(opt ?? null)
        expect(r.vector((x) => x.u8())).toEqual([1, 2, 3])
        r.end()
      }),
    )
  })

  it('round-trips base64url strictly', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 100 }), (b) => {
        const s = toB64url(b)
        expect(s).not.toMatch(/[=+/]/)
        expect(fromB64url(s)).toEqual(b)
      }),
    )
    expect(() => fromB64url('AB==')).toThrow(CodecError)
    expect(() => fromB64url('AB')).toThrow(CodecError) // non-canonical trailing bits
  })

  it('maps UUIDs to 16 bytes', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
    expect(bytesToUuid(uuidToBytes(id))).toBe(id)
    expect(() => uuidToBytes(id.toUpperCase())).toThrow(CodecError)
  })
})
