/**
 * Byte helpers for the DS: strict base64url (§12.2 JSON wires), UUID bytes,
 * and a small reader for the RFC 9420 presentation language.
 */
import { z } from 'zod'

const B64URL = /^[A-Za-z0-9_-]*$/

/** base64url without padding. */
export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url')
}

/**
 * Strict decode: rejects padding, other alphabets and non-zero trailing bits
 * (the re-encode must give the same text). Returns null on bad input.
 */
export function fromB64(s: string): Uint8Array | null {
  if (!B64URL.test(s) || s.length % 4 === 1) return null
  const buf = Buffer.from(s, 'base64url')
  if (buf.toString('base64url') !== s) return null
  return new Uint8Array(buf)
}

/** zod: a base64url string that decodes, with an optional byte cap. */
export function b64(maxBytes?: number) {
  return z
    .string()
    .transform((s, ctx) => {
      const bytes = fromB64(s)
      if (!bytes) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid base64url' })
        return z.NEVER
      }
      if (maxBytes !== undefined && bytes.length > maxBytes) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `above ${maxBytes} bytes` })
        return z.NEVER
      }
      return bytes
    })
}

export function bytesEqual(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Canonical lowercase UUID text → 16 bytes. */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a uuid: ${uuid}`)
  return new Uint8Array(Buffer.from(hex, 'hex'))
}

export function bytesToUuid(b: Uint8Array): string {
  if (b.length !== 16) throw new Error('uuid needs 16 bytes')
  const h = Buffer.from(b).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export class ParseError extends Error {
  override readonly name = 'ParseError'
}

/** Reader for the RFC 9420 §2.1 presentation language (minimal varints). */
export class Reader {
  private pos = 0
  constructor(private readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.pos
  }

  private take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw new ParseError('truncated')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  u8(): number {
    return this.take(1)[0]!
  }

  u16(): number {
    const b = this.take(2)
    return (b[0]! << 8) | b[1]!
  }

  u32(): number {
    const b = this.take(4)
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
  }

  /** uint64 as a JS number. Rejects values at or above 2^53 (§12.2). */
  u64(): number {
    const b = this.take(8)
    const hi = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
    const lo = ((b[4]! << 24) | (b[5]! << 16) | (b[6]! << 8) | b[7]!) >>> 0
    if (hi >= 0x200000) throw new ParseError('uint64 above 2^53')
    return hi * 0x100000000 + lo
  }

  varint(): number {
    const first = this.u8()
    const prefix = first >> 6
    if (prefix === 0) return first & 0x3f
    if (prefix === 1) {
      const v = ((first & 0x3f) << 8) | this.u8()
      if (v < 0x40) throw new ParseError('non-minimal varint')
      return v
    }
    if (prefix === 2) {
      const rest = this.take(3)
      const v = (((first & 0x3f) << 24) | (rest[0]! << 16) | (rest[1]! << 8) | rest[2]!) >>> 0
      if (v < 0x4000) throw new ParseError('non-minimal varint')
      return v
    }
    throw new ParseError('invalid varint prefix')
  }

  fixed(n: number): Uint8Array {
    return this.take(n)
  }

  opaque(): Uint8Array {
    return this.take(this.varint())
  }

  end(): void {
    if (this.remaining !== 0) throw new ParseError('trailing bytes')
  }
}
