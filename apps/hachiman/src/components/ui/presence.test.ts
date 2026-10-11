import { describe, expect, it } from 'vitest'
import { PRESENCE_OUTSET, PRESENCE_RING, presenceDotSize, presenceHole } from './presence'

describe('presenceDotSize', () => {
  it('takes the drawn sizes of the mobile kit', () => {
    expect(presenceDotSize(24)).toBe(9)
    expect(presenceDotSize(28)).toBe(10)
    expect(presenceDotSize(72)).toBe(24)
  })

  it('falls back to a third of the avatar, never under 8', () => {
    expect(presenceDotSize(20)).toBe(8)
    expect(presenceDotSize(60)).toBe(20)
  })
})

describe('presenceHole', () => {
  it('centres the hole on the dot, which sticks out by the outset, with the ring around it', () => {
    expect(presenceHole(28)).toEqual([24, 24, 7.5])
  })

  it('uses the ring and the outset of the dot', () => {
    const r = presenceDotSize(40) / 2
    const c = 40 + PRESENCE_OUTSET - r
    expect(presenceHole(40)).toEqual([c, c, r + PRESENCE_RING])
  })
})
