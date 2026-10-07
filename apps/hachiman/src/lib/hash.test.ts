import { describe, expect, it } from 'vitest'
import { hashString } from '@/lib/hash'
import { userHue } from '@/lib/user-tint'

describe('hashString', () => {
  it('is FNV-1a 32-bit, unsigned', () => {
    expect(hashString('')).toBe(0x811c9dc5)
    expect(hashString('a')).toBe(0xe40c292c)
  })

  it('gives the hues of the tints', () => {
    expect(userHue('a')).toBe(0xe40c292c % 360)
  })
})
