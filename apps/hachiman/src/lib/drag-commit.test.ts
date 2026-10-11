import { describe, expect, it } from 'vitest'
import { shouldCommitDrag } from './drag-commit'

const size = 400

describe('shouldCommitDrag', () => {
  it('commits a slow drag past 35 % of the size', () => {
    expect(shouldCommitDrag({ offset: 141, size, velocity: 0.1, msSinceLastMove: 16 })).toBe(true)
  })

  it('snaps back a slow, short drag', () => {
    expect(shouldCommitDrag({ offset: 140, size, velocity: 0.1, msSinceLastMove: 16 })).toBe(false)
    expect(shouldCommitDrag({ offset: 0, size, velocity: 0, msSinceLastMove: 0 })).toBe(false)
  })

  it('commits a short flick', () => {
    expect(shouldCommitDrag({ offset: 30, size, velocity: 0.6, msSinceLastMove: 16 })).toBe(true)
  })

  it('does not count a flick that stopped before the lift', () => {
    expect(shouldCommitDrag({ offset: 30, size, velocity: 0.6, msSinceLastMove: 101 })).toBe(false)
    expect(shouldCommitDrag({ offset: 30, size, velocity: 0.6, msSinceLastMove: 100 })).toBe(true)
  })

  it('does not count an upward flick', () => {
    expect(shouldCommitDrag({ offset: 30, size, velocity: -2, msSinceLastMove: 16 })).toBe(false)
  })
})
