/**
 * QR Code encoder, byte mode only, versions 1 to 40 (ISO/IEC 18004).
 *
 * A reduced port of the QR Code generator library by Project Nayuki (MIT License),
 * https://www.nayuki.io/page/qr-code-generator-library. Copyright (c) Project Nayuki.
 * The MIT License: permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files, to deal in the Software without restriction,
 * provided that the copyright notice and this permission notice are included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND.
 *
 * Changes from the reference: only the byte segment mode, a fixed error correction level (the
 * callers use M, §12.5 codes), no ECC boost, and an SVG path output. The link and verify payloads
 * are ASCII, so byte mode is enough.
 */

export type Ecc = 'L' | 'M' | 'Q' | 'H'

const ECC_ORDINAL: Record<Ecc, number> = { L: 0, M: 1, Q: 2, H: 3 }
/** The two format bits of each level (ISO/IEC 18004 table 12). */
const ECC_FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 }

export const MIN_VERSION = 1
export const MAX_VERSION = 40

// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  // Version: (index 0 is padding)
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30] // H
]

// prettier-ignore
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81] // H
]

const PENALTY_N1 = 3
const PENALTY_N2 = 3
const PENALTY_N3 = 40
const PENALTY_N4 = 10

/** An encoded symbol. `modules[y][x]` is true for a dark module. */
export interface QrCode {
  version: number
  ecc: Ecc
  /** 0 to 7. */
  mask: number
  /** 4 × version + 17. */
  size: number
  modules: boolean[][]
}

const getBit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0

/** Modules that carry data and ECC bits (all but the function patterns and format/version areas). */
export function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

export function numDataCodewords(ver: number, ecc: Ecc): number {
  const e = ECC_ORDINAL[ecc]
  return (
    Math.floor(numRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[e]![ver]! * NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!
  )
}

/** Bits of the byte-mode character count field. */
const countBits = (ver: number): number => (ver <= 9 ? 8 : 16)

/** The largest byte payload that fits `ver` at `ecc`. */
export function byteCapacity(ver: number, ecc: Ecc): number {
  const bits = numDataCodewords(ver, ecc) * 8 - 4 - countBits(ver)
  return Math.min(Math.floor(bits / 8), (1 << countBits(ver)) - 1)
}

// MARK: - Reed-Solomon over GF(2^8/0x11D)

export function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

/** The generator polynomial of `degree`, highest coefficient first and the leading 1 left out. */
export function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root)
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

export function reedSolomonRemainder(
  data: readonly number[],
  divisor: readonly number[]
): number[] {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ result.shift()!
    result.push(0)
    divisor.forEach((coef, i) => (result[i]! ^= gfMultiply(coef, factor)))
  }
  return result
}

// MARK: - Format and version information

/** The 15 format bits for `ecc` and `mask`, BCH-coded and XOR-masked. */
export function formatBits(ecc: Ecc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** The 18 version bits (versions 7 and above). */
export function versionBits(ver: number): number {
  let rem = ver
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (ver << 12) | rem
}

export function alignmentPatternPositions(ver: number): number[] {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
  const result = [6]
  for (let pos = ver * 4 + 17 - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

// MARK: - Encoding

/** The data codewords of one byte segment, with terminator and pad bytes. */
export function dataCodewords(data: Uint8Array, ver: number, ecc: Ecc): number[] {
  const bits: number[] = []
  const append = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  append(0x4, 4)
  append(data.length, countBits(ver))
  for (const b of data) append(b, 8)
  const capacity = numDataCodewords(ver, ecc) * 8
  if (bits.length > capacity) throw new RangeError('data too long for this version')
  append(0, Math.min(4, capacity - bits.length))
  append(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]!
    out.push(v)
  }
  return out
}

/** Splits into blocks, adds the ECC of each block and interleaves (ISO/IEC 18004 §7.6). */
export function addEccAndInterleave(data: readonly number[], ver: number, ecc: Ecc): number[] {
  const e = ECC_ORDINAL[ecc]
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e]![ver]!
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const divisor = reedSolomonDivisor(blockEccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const block = [...dat]
    const eccWords = reedSolomonRemainder(dat, divisor)
    if (i < numShortBlocks) block.push(0)
    blocks.push(block.concat(eccWords))
  }
  const result: number[] = []
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      // The pad byte of a short block is not part of the symbol.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!)
    })
  }
  return result
}

/** True where `mask` inverts a data module at (x, y). */
export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      throw new RangeError('mask must be 0 to 7')
  }
}

class Builder {
  readonly size: number
  readonly modules: boolean[][]
  readonly isFunction: boolean[][]

  constructor(
    readonly version: number,
    readonly ecc: Ecc
  ) {
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false)
    )
    this.isFunction = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false)
    )
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark
    this.isFunction[y]![x] = true
  }

  drawFunctionPatterns(): void {
    const size = this.size
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0)
      this.set(i, 6, i % 2 === 0)
    }
    this.drawFinder(3, 3)
    this.drawFinder(size - 4, 3)
    this.drawFinder(3, size - 4)
    const pos = alignmentPatternPositions(this.version)
    const n = pos.length
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // The three corners with a finder pattern have no alignment pattern.
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)))
          this.drawAlignment(pos[i]!, pos[j]!)
      }
    }
    this.drawFormat(0) // reserves the area; drawn again with the real mask
    this.drawVersion()
  }

  drawFormat(mask: number): void {
    const bits = formatBits(this.ecc, mask)
    const size = this.size
    for (let i = 0; i <= 5; i++) this.set(8, i, getBit(bits, i))
    this.set(8, 7, getBit(bits, 6))
    this.set(8, 8, getBit(bits, 7))
    this.set(7, 8, getBit(bits, 8))
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, getBit(bits, i))
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, getBit(bits, i))
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, getBit(bits, i))
    this.set(8, size - 8, true) // the dark module
  }

  private drawVersion(): void {
    if (this.version < 7) return
    const bits = versionBits(this.version)
    for (let i = 0; i < 18; i++) {
      const dark = getBit(bits, i)
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.set(a, b, dark)
      this.set(b, a, dark)
    }
  }

  private drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size)
          this.set(xx, yy, dist !== 2 && dist !== 4)
      }
    }
  }

  private drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }

  drawCodewords(data: readonly number[]): void {
    const size = this.size
    let i = 0
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5 // skip the vertical timing pattern
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? size - 1 - vert : vert
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = getBit(data[i >>> 3]!, 7 - (i & 7))
            i++
          }
          // Remainder bits stay light (false).
        }
      }
    }
  }

  /** XOR is its own inverse: a second call with the same mask undoes the first. */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (!this.isFunction[y]![x] && maskBit(mask, x, y))
          this.modules[y]![x] = !this.modules[y]![x]
  }

  penalty(): number {
    const size = this.size
    const m = this.modules
    let result = 0
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let runColor = false
        let run = 0
        const history = [0, 0, 0, 0, 0, 0, 0]
        for (let b = 0; b < size; b++) {
          const dark = pass === 0 ? m[a]![b]! : m[b]![a]!
          if (dark === runColor) {
            run++
            if (run === 5) result += PENALTY_N1
            else if (run > 5) result++
          } else {
            this.addHistory(run, history)
            if (!runColor) result += this.countFinderLike(history) * PENALTY_N3
            runColor = dark
            run = 1
          }
        }
        result += this.terminateAndCount(runColor, run, history) * PENALTY_N3
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y]![x]
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) result += PENALTY_N2
      }
    }
    let dark = 0
    for (const row of m) for (const c of row) if (c) dark++
    const total = size * size
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
    result += k * PENALTY_N4
    return result
  }

  private countFinderLike(h: readonly number[]): number {
    const n = h[1]!
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n
    return (
      (core && h[0]! >= n * 4 && h[6]! >= n ? 1 : 0) +
      (core && h[6]! >= n * 4 && h[0]! >= n ? 1 : 0)
    )
  }

  private terminateAndCount(runColor: boolean, run: number, h: number[]): number {
    if (runColor) {
      this.addHistory(run, h)
      run = 0
    }
    run += this.size // the light border after the last run
    this.addHistory(run, h)
    return this.countFinderLike(h)
  }

  private addHistory(run: number, h: number[]): void {
    if (h[0] === 0) run += this.size // the light border before the first run
    h.pop()
    h.unshift(run)
  }
}

/** The smallest version that holds `byteLength` bytes at `ecc`, or null. */
export function versionFor(byteLength: number, ecc: Ecc): number | null {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) if (byteLength <= byteCapacity(v, ecc)) return v
  return null
}

/**
 * Encodes `text` (UTF-8) in byte mode at the smallest version that fits. `mask` -1 selects the
 * mask with the lowest penalty. Throws RangeError when the text is too long for version 40.
 */
export function encodeQr(text: string | Uint8Array, ecc: Ecc = 'M', mask = -1): QrCode {
  const data = typeof text === 'string' ? new TextEncoder().encode(text) : text
  const version = versionFor(data.length, ecc)
  if (version === null) throw new RangeError('data too long for a QR code')
  if (mask < -1 || mask > 7) throw new RangeError('mask must be -1 to 7')
  const b = new Builder(version, ecc)
  b.drawFunctionPatterns()
  b.drawCodewords(addEccAndInterleave(dataCodewords(data, version, ecc), version, ecc))
  if (mask === -1) {
    let best = Infinity
    for (let i = 0; i < 8; i++) {
      b.applyMask(i)
      b.drawFormat(i)
      const p = b.penalty()
      if (p < best) {
        mask = i
        best = p
      }
      b.applyMask(i)
    }
  }
  b.applyMask(mask)
  b.drawFormat(mask)
  return { version, ecc, mask, size: b.size, modules: b.modules }
}

/**
 * One SVG path for the dark modules, in module units, offset by `border` (the quiet zone, 4 by
 * the standard). Use it with viewBox `0 0 (size + 2 × border) (size + 2 × border)`.
 */
export function qrSvgPath(qr: QrCode, border = 4): string {
  const parts: string[] = []
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y]![x]) continue
      // One horizontal run per path segment keeps the path short.
      let w = 1
      while (x + w < qr.size && qr.modules[y]![x + w]) w++
      parts.push(`M${x + border},${y + border}h${w}v1h-${w}z`)
      x += w - 1
    }
  }
  return parts.join('')
}
