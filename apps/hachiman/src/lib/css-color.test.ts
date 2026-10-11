import { describe, expect, it } from 'vitest'
import { parseRgb, rgbaToHex } from './css-color'

describe('parseRgb', () => {
  it('reads the legacy computed forms', () => {
    expect(parseRgb('rgb(14, 15, 21)')).toEqual([14, 15, 21, 255])
    expect(parseRgb('rgba(5, 6, 10, 0.65)')).toEqual([5, 6, 10, 166])
    expect(parseRgb('rgba(0, 0, 0, 0)')).toEqual([0, 0, 0, 0])
  })

  it('reads the space-separated forms', () => {
    expect(parseRgb('rgb(14 15 21)')).toEqual([14, 15, 21, 255])
    expect(parseRgb('rgb(14 15 21 / 50%)')).toEqual([14, 15, 21, 128])
    expect(parseRgb(' rgb(1.5 2 3 / 0.5) ')).toEqual([1.5, 2, 3, 128])
  })

  it('refuses other forms', () => {
    expect(parseRgb('oklab(0.2 0.01 -0.05)')).toBeNull()
    expect(parseRgb('color(srgb 0.1 0.2 0.3)')).toBeNull()
    expect(parseRgb('#0e0f15')).toBeNull()
    expect(parseRgb('')).toBeNull()
  })
})

describe('rgbaToHex', () => {
  it('gives #rrggbb for an opaque colour', () => {
    expect(rgbaToHex([14, 15, 21, 255])).toBe('#0e0f15')
    expect(rgbaToHex([255, 255, 255, 255])).toBe('#ffffff')
  })

  it('adds the alpha byte when the colour is not opaque', () => {
    expect(rgbaToHex([5, 6, 10, 166])).toBe('#05060aa6')
  })

  it('rounds and clamps the channels', () => {
    expect(rgbaToHex([1.5, -3, 300, 255])).toBe('#0200ff')
  })
})
