import { describe, expect, it } from 'vitest'
import {
  addEccAndInterleave,
  alignmentPatternPositions,
  byteCapacity,
  dataCodewords,
  encodeQr,
  formatBits,
  gfMultiply,
  maskBit,
  numDataCodewords,
  numRawDataModules,
  qrSvgPath,
  reedSolomonDivisor,
  reedSolomonRemainder,
  versionBits,
  type Ecc,
  type QrCode
} from './qr'

// ISO/IEC 18004 table 7: byte-mode capacity at level M, versions 1 to 40.
// prettier-ignore
const BYTE_CAPACITY_M = [
  14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666,
  711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989,
  2099, 2213, 2331
]

describe('QR tables', () => {
  it('byte capacity at M matches ISO/IEC 18004 for every version', () => {
    for (let v = 1; v <= 40; v++)
      expect([v, byteCapacity(v, 'M')]).toEqual([v, BYTE_CAPACITY_M[v - 1]])
  })

  it('data codewords of versions 1 and 40 at each level', () => {
    expect((['L', 'M', 'Q', 'H'] as Ecc[]).map((e) => numDataCodewords(1, e))).toEqual([
      19, 16, 13, 9
    ])
    expect((['L', 'M', 'Q', 'H'] as Ecc[]).map((e) => numDataCodewords(40, e))).toEqual([
      2956, 2334, 1666, 1276
    ])
    expect(Math.floor(numRawDataModules(1) / 8)).toBe(26)
    expect(Math.floor(numRawDataModules(40) / 8)).toBe(3706)
  })

  it('format bits match the ISO/IEC 18004 annex C table', () => {
    expect(formatBits('M', 0)).toBe(0b101010000010010)
    expect(formatBits('L', 0)).toBe(0b111011111000100)
    expect(formatBits('Q', 0)).toBe(0b011010101011111)
    expect(formatBits('H', 0)).toBe(0b001011010001001)
    expect(formatBits('M', 4)).toBe(0b100010111111001)
    expect(formatBits('M', 7)).toBe(0b100101010100000)
  })

  it('version bits match the ISO/IEC 18004 annex D table', () => {
    expect(versionBits(7)).toBe(0x07c94)
    expect(versionBits(21)).toBe(0x15683)
    expect(versionBits(40)).toBe(0x28c69)
  })

  it('alignment pattern positions', () => {
    expect(alignmentPatternPositions(1)).toEqual([])
    expect(alignmentPatternPositions(2)).toEqual([6, 18])
    expect(alignmentPatternPositions(7)).toEqual([6, 22, 38])
    expect(alignmentPatternPositions(32)).toEqual([6, 34, 60, 86, 112, 138])
    expect(alignmentPatternPositions(36)).toEqual([6, 24, 50, 76, 102, 128, 154])
    expect(alignmentPatternPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170])
  })

  it('Reed-Solomon ECC of the "HELLO WORLD" 1-M example', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
    expect(reedSolomonRemainder(data, reedSolomonDivisor(10))).toEqual([
      196, 35, 39, 119, 235, 215, 231, 226, 93, 23
    ])
  })
})

// MARK: - An independent reader: function areas from the standard, then unmask, read, check RS.

function functionArea(size: number, version: number): boolean[][] {
  const f = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const box = (x0: number, y0: number, w: number, h: number): void => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) f[y]![x] = true
  }
  box(0, 0, 9, 9) // finder, separator, format
  box(size - 8, 0, 8, 9)
  box(0, size - 8, 9, 8)
  box(6, 0, 1, size) // timing
  box(0, 6, size, 1)
  const inFinder = (x: number, y: number): boolean =>
    (x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8)
  const pos = alignmentPatternPositions(version)
  for (const ay of pos) for (const ax of pos) if (!inFinder(ax, ay)) box(ax - 2, ay - 2, 5, 5)
  if (version >= 7) {
    box(size - 11, 0, 3, 6)
    box(0, size - 11, 6, 3)
  }
  return f
}

const gfPow = (e: number): number => {
  let r = 1
  for (let i = 0; i < e; i++) r = gfMultiply(r, 2)
  return r
}

/** Every syndrome of a valid RS codeword is zero. */
function syndromesZero(block: number[], eccLen: number): boolean {
  for (let i = 0; i < eccLen; i++) {
    const a = gfPow(i)
    let s = 0
    for (const c of block) s = gfMultiply(s, a) ^ c
    if (s !== 0) return false
  }
  return true
}

function readFormat(qr: QrCode): number {
  const m = qr.modules
  let a = 0
  for (let i = 0; i <= 5; i++) a |= (m[i]![8] ? 1 : 0) << i
  a |= (m[7]![8] ? 1 : 0) << 6
  a |= (m[8]![8] ? 1 : 0) << 7
  a |= (m[8]![7] ? 1 : 0) << 8
  for (let i = 9; i < 15; i++) a |= (m[8]![14 - i] ? 1 : 0) << i
  let b = 0
  for (let i = 0; i < 8; i++) b |= (m[8]![qr.size - 1 - i] ? 1 : 0) << i
  for (let i = 8; i < 15; i++) b |= (m[qr.size - 15 + i]![8] ? 1 : 0) << i
  expect(a).toBe(b)
  return a
}

function decode(qr: QrCode): Uint8Array {
  const { size, version, ecc } = qr
  expect(size).toBe(version * 4 + 17)
  expect(readFormat(qr)).toBe(formatBits(ecc, qr.mask))
  expect(qr.modules[size - 8]![8]).toBe(true) // the dark module
  if (version >= 7) {
    let bits = 0
    for (let i = 0; i < 18; i++)
      bits |= (qr.modules[Math.floor(i / 3)]![size - 11 + (i % 3)] ? 1 : 0) << i
    expect(bits).toBe(versionBits(version))
  }
  // Finder pattern centres are dark, rings light/dark.
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4]
  ] as const) {
    expect(qr.modules[cy]![cx]).toBe(true)
    expect(qr.modules[cy]![cx + 2]).toBe(false)
    expect(qr.modules[cy]![cx + 3]).toBe(true)
  }
  const f = functionArea(size, version)
  const bits: number[] = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const x = right - j
        if (f[y]![x]) continue
        bits.push(qr.modules[y]![x]! !== maskBit(qr.mask, x, y) ? 1 : 0)
      }
    }
  }
  expect(bits.length).toBe(numRawDataModules(version))
  const raw: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) raw.push(parseInt(bits.slice(i, i + 8).join(''), 2))

  // De-interleave. The block layout is derived from the totals, not from the encoder tables.
  const total = raw.length
  const dataLen = numDataCodewords(version, ecc)
  const eccTotal = total - dataLen
  for (let n = 1; n <= 81; n++) {
    if (eccTotal % n === 0) {
      // Try each block count: only the right one gives valid RS blocks.
      const e = eccTotal / n
      const shortData = Math.floor(dataLen / n)
      const longCount = dataLen % n
      const blocks: number[][] = Array.from(
        { length: n },
        (_, i) => new Array<number>(shortData + (i >= n - longCount ? 1 : 0))
      )
      let k = 0
      for (let i = 0; i <= shortData; i++)
        for (let b = 0; b < n; b++) if (i < blocks[b]!.length) blocks[b]![i] = raw[k++]!
      const eccs: number[][] = Array.from({ length: n }, () => [])
      for (let i = 0; i < e; i++) for (let b = 0; b < n; b++) eccs[b]!.push(raw[k++]!)
      if (blocks.every((d, b) => syndromesZero([...d, ...eccs[b]!], e))) {
        const data = blocks.flat()
        const r = {
          bits: data.flatMap((v) => [...v.toString(2).padStart(8, '0')].map(Number)),
          p: 0
        }
        const take = (len: number): number => {
          let v = 0
          for (let i = 0; i < len; i++) v = (v << 1) | r.bits[r.p++]!
          return v
        }
        expect(take(4)).toBe(0x4)
        const count = take(version <= 9 ? 8 : 16)
        const out = new Uint8Array(count)
        for (let i = 0; i < count; i++) out[i] = take(8)
        return out
      }
    }
  }
  throw new Error('no block layout gives valid Reed-Solomon codewords')
}

const bytes = (n: number, seed: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7 + 13) & 0xff)

describe('encodeQr', () => {
  it('picks the smallest version: 14 bytes fit version 1, 15 need version 2', () => {
    expect(encodeQr(bytes(14, 1)).version).toBe(1)
    expect(encodeQr(bytes(15, 1)).version).toBe(2)
    expect(encodeQr(bytes(2331, 1)).version).toBe(40)
    expect(() => encodeQr(bytes(2332, 1))).toThrow(RangeError)
  })

  it('fixed payloads give a fixed version, level and mask', () => {
    const payload = 'hachiman-verify:1:' + 'A'.repeat(130)
    const qr = encodeQr(payload)
    // Regression pins: the penalty rules of the reference choose these masks. decode() checks
    // that each symbol is valid.
    expect([qr.version, qr.ecc, qr.mask]).toEqual([8, 'M', 3])
    expect(qr.version).toBe(versionForLength(payload.length))
    expect(new TextDecoder().decode(decode(qr))).toBe(payload)
    const hello = encodeQr('Hello, world!')
    expect([hello.version, hello.ecc, hello.mask]).toEqual([1, 'M', 2])
    expect(new TextDecoder().decode(decode(hello))).toBe('Hello, world!')
  })

  it('each forced mask still decodes to the same bytes', () => {
    const data = new TextEncoder().encode('Hello, world! 123')
    for (let mask = 0; mask < 8; mask++) {
      const qr = encodeQr(data, 'M', mask)
      expect(qr.mask).toBe(mask)
      expect([...decode(qr)]).toEqual([...data])
    }
  })

  for (const n of [0, 1, 14, 15, 106, 107, 250, 330, 1000, 2331]) {
    it(`round-trips ${n} bytes through an independent reader (RS syndromes, format, version)`, () => {
      const data = bytes(n, n)
      expect([...decode(encodeQr(data))]).toEqual([...data])
    })
  }

  it('other levels round-trip too', () => {
    for (const ecc of ['L', 'Q', 'H'] as Ecc[]) {
      const data = bytes(200, 3)
      const qr = encodeQr(data, ecc)
      expect(qr.ecc).toBe(ecc)
      expect([...decode(qr)]).toEqual([...data])
    }
  })

  it('pads with 0xEC 0x11 after the terminator', () => {
    const words = dataCodewords(new Uint8Array([0x41]), 1, 'M')
    expect(words).toHaveLength(16)
    // 0100 00000001 01000001 0000 → 0x40 0x14 0x10, then pad bytes.
    expect(words.slice(0, 5)).toEqual([0x40, 0x14, 0x10, 0xec, 0x11])
    expect(addEccAndInterleave(words, 1, 'M')).toHaveLength(26)
  })

  it('the SVG path covers exactly the dark modules', () => {
    const qr = encodeQr('hachiman')
    const dark = qr.modules.flat().filter(Boolean).length
    const widths = [...qrSvgPath(qr).matchAll(/h(\d+)v1/g)].reduce((s, m) => s + Number(m[1]), 0)
    expect(widths).toBe(dark)
  })
})

function versionForLength(n: number): number {
  return BYTE_CAPACITY_M.findIndex((c) => n <= c) + 1
}
