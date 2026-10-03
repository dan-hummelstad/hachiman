/**
 * The one binary codec of Hachiman objects (docs/gateway-protocol.md §12.2).
 *
 * It is the RFC 9420 §2.1 presentation language: big-endian fixed-width
 * integers, `opaque x<V>` with the MLS variable-length (QUIC-style) prefix,
 * `optional<T>` as a uint8 presence flag, structs as concatenation. The format
 * is deterministic: one value has exactly one encoding, and the Reader rejects
 * non-minimal length prefixes and trailing bytes.
 */

export class CodecError extends Error {
  override readonly name = 'CodecError'
}

const MAX_VARINT = 0x3fffffff

export class Writer {
  private buf = new Uint8Array(256)
  private len = 0

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.len + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new CodecError(`u8 out of range: ${v}`)
    this.ensure(1)
    this.buf[this.len++] = v
    return this
  }

  u16(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new CodecError(`u16 out of range: ${v}`)
    this.ensure(2)
    this.buf[this.len++] = v >>> 8
    this.buf[this.len++] = v & 0xff
    return this
  }

  u32(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new CodecError(`u32 out of range: ${v}`)
    this.ensure(4)
    new DataView(this.buf.buffer).setUint32(this.len, v)
    this.len += 4
    return this
  }

  u64(v: bigint | number): this {
    const b = typeof v === 'bigint' ? v : BigInt(v)
    if (b < 0n || b > 0xffffffffffffffffn) throw new CodecError(`u64 out of range: ${b}`)
    this.ensure(8)
    new DataView(this.buf.buffer).setBigUint64(this.len, b)
    this.len += 8
    return this
  }

  /** RFC 9420 §2.1.2 variable-length integer, minimal encoding. */
  varint(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > MAX_VARINT) throw new CodecError(`varint out of range: ${v}`)
    if (v < 0x40) return this.u8(v)
    if (v < 0x4000) return this.u16(0x4000 | v)
    return this.u32((0x80000000 | v) >>> 0)
  }

  /** Fixed-length bytes (`opaque x[N]`). */
  fixed(bytes: Uint8Array, n: number): this {
    if (bytes.length !== n) throw new CodecError(`expected ${n} bytes, got ${bytes.length}`)
    this.ensure(n)
    this.buf.set(bytes, this.len)
    this.len += n
    return this
  }

  /** `opaque x<V>`. */
  opaque(bytes: Uint8Array): this {
    this.varint(bytes.length)
    this.ensure(bytes.length)
    this.buf.set(bytes, this.len)
    this.len += bytes.length
    return this
  }

  /** `opaque x<V>` holding UTF-8. */
  utf8(s: string): this {
    return this.opaque(new TextEncoder().encode(s))
  }

  /** `T x<V>`: a length-prefixed vector of encoded items. */
  vector<T>(items: readonly T[], write: (w: Writer, item: T) => void): this {
    const inner = new Writer()
    for (const item of items) write(inner, item)
    return this.opaque(inner.finish())
  }

  /** `optional<T>`. */
  optional<T>(value: T | null | undefined, write: (w: Writer, v: T) => void): this {
    if (value === null || value === undefined) return this.u8(0)
    this.u8(1)
    write(this, value)
    return this
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

export class Reader {
  private pos = 0
  constructor(private readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.pos
  }

  private take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new CodecError('unexpected end of input')
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
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0)
  }

  u64(): bigint {
    const b = this.take(8)
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0)
  }

  /** A u64 that must fit in a JS-safe integer (epochs, sizes, timestamps). */
  u64n(): number {
    const v = this.u64()
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new CodecError('u64 exceeds 2^53')
    return Number(v)
  }

  varint(): number {
    const first = this.u8()
    const prefix = first >>> 6
    if (prefix === 0) return first
    if (prefix === 1) {
      const v = ((first & 0x3f) << 8) | this.u8()
      if (v < 0x40) throw new CodecError('non-minimal varint')
      return v
    }
    if (prefix === 2) {
      const rest = this.take(3)
      const v = ((first & 0x3f) * 0x1000000 + ((rest[0]! << 16) | (rest[1]! << 8) | rest[2]!)) >>> 0
      if (v < 0x4000) throw new CodecError('non-minimal varint')
      return v
    }
    throw new CodecError('invalid varint prefix')
  }

  fixed(n: number): Uint8Array {
    return this.take(n).slice()
  }

  opaque(max = Number.MAX_SAFE_INTEGER): Uint8Array {
    const n = this.varint()
    if (n > max) throw new CodecError(`opaque longer than ${max}`)
    return this.take(n).slice()
  }

  utf8(max = Number.MAX_SAFE_INTEGER): string {
    const b = this.opaque(max)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b)
    } catch {
      // The decoder throws a TypeError on bad UTF-8. Callers expect only CodecError.
      throw new CodecError('invalid UTF-8')
    }
  }

  vector<T>(read: (r: Reader) => T, maxItems = Number.MAX_SAFE_INTEGER): T[] {
    const inner = new Reader(this.opaque())
    const out: T[] = []
    while (inner.remaining > 0) {
      if (out.length >= maxItems) throw new CodecError(`vector longer than ${maxItems}`)
      out.push(read(inner))
    }
    return out
  }

  optional<T>(read: (r: Reader) => T): T | null {
    const flag = this.u8()
    if (flag === 0) return null
    if (flag !== 1) throw new CodecError('invalid optional flag')
    return read(this)
  }

  /** Throws unless every byte was read. Call it after the last field. */
  end(): void {
    if (this.remaining !== 0) throw new CodecError(`${this.remaining} trailing bytes`)
  }
}

/** Encodes one value with a Writer callback. */
export function encode(write: (w: Writer) => void): Uint8Array {
  const w = new Writer()
  write(w)
  return w.finish()
}

/** Decodes one value and rejects trailing bytes. */
export function decode<T>(bytes: Uint8Array, read: (r: Reader) => T): T {
  const r = new Reader(bytes)
  const v = read(r)
  r.end()
  return v
}

// MARK: - base64url (RFC 4648 §5, no padding): the encoding of bytes on every JSON wire

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64URL_REV = new Int16Array(128).fill(-1)
for (let i = 0; i < B64URL.length; i++) B64URL_REV[B64URL.charCodeAt(i)] = i

export function toB64url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64URL[n >>> 18]! + B64URL[(n >>> 12) & 63]! + B64URL[(n >>> 6) & 63]! + B64URL[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += B64URL[n >>> 18]! + B64URL[(n >>> 12) & 63]!
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64URL[n >>> 18]! + B64URL[(n >>> 12) & 63]! + B64URL[(n >>> 6) & 63]!
  }
  return out
}

/** Strict: rejects padding, other alphabets and non-canonical trailing bits. */
export function fromB64url(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new CodecError('invalid base64url length')
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const v = c < 128 ? B64URL_REV[c]! : -1
    if (v < 0) throw new CodecError('invalid base64url character')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >>> bits) & 0xff
    }
  }
  if ((acc & ((1 << bits) - 1)) !== 0) throw new CodecError('non-canonical base64url')
  return out
}

// MARK: - UUIDs as 16 bytes

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Canonical lowercase UUID text → 16 bytes. */
export function uuidToBytes(uuid: string): Uint8Array {
  if (!UUID_RE.test(uuid)) throw new CodecError(`not a canonical lowercase UUID: ${uuid}`)
  const hex = uuid.replaceAll('-', '')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** 16 bytes → canonical lowercase UUID text. */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new CodecError('UUID must be 16 bytes')
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
