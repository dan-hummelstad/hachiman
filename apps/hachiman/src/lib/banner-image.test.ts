import { describe, expect, it } from 'vitest'
import {
  BANNER_MAX_WIDTH,
  bannerFileName,
  bannerSize,
  fallbackType,
  opaqueFill
} from './banner-image'

describe('bannerSize', () => {
  it('scales to at most BANNER_MAX_WIDTH wide and keeps the aspect ratio', () => {
    expect(bannerSize(4096, 1024)).toEqual({ width: BANNER_MAX_WIDTH, height: 512 })
    expect(bannerSize(3000, 2000)).toEqual({ width: 2048, height: 1365 })
    expect(bannerSize(100_000, 1)).toEqual({ width: 2048, height: 1 })
  })

  it('never scales up', () => {
    expect(bannerSize(2048, 4000)).toEqual({ width: 2048, height: 4000 })
    expect(bannerSize(640, 160)).toEqual({ width: 640, height: 160 })
  })
})

describe('the WebKit fallback', () => {
  it('encodes again as JPEG when the WebP request gave PNG or nothing', () => {
    expect(fallbackType('image/webp')).toBeNull()
    expect(fallbackType('image/jpeg')).toBeNull()
    expect(fallbackType('image/png')).toBe('image/jpeg')
    expect(fallbackType('')).toBe('image/jpeg')
  })

  it('puts white under a JPEG, which has no alpha, and keeps the alpha of WebP', () => {
    expect(opaqueFill('image/jpeg')).toBe('#fff')
    expect(opaqueFill('image/webp')).toBeNull()
    expect(opaqueFill(fallbackType('image/png') ?? '')).toBe('#fff')
  })

  it('names the file after its type, never after the original', () => {
    expect(bannerFileName('image/webp')).toBe('banner.webp')
    expect(bannerFileName('image/jpeg')).toBe('banner.jpg')
  })
})
