import { describe, expect, it } from 'vitest'
import { radioStep } from '@/lib/roving'

describe('radioStep', () => {
  it('moves and wraps with the arrow keys', () => {
    expect(radioStep(0, 3, 'ArrowRight')).toBe(1)
    expect(radioStep(2, 3, 'ArrowDown')).toBe(0)
    expect(radioStep(0, 3, 'ArrowLeft')).toBe(2)
    expect(radioStep(1, 3, 'ArrowUp')).toBe(0)
  })
  it('jumps with Home and End and ignores other keys', () => {
    expect(radioStep(1, 3, 'Home')).toBe(0)
    expect(radioStep(0, 3, 'End')).toBe(2)
    expect(radioStep(0, 3, 'Enter')).toBeNull()
    expect(radioStep(0, 0, 'ArrowRight')).toBeNull()
  })
})
