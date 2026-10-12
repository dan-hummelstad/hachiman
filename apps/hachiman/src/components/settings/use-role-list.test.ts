import { describe, expect, it, vi } from 'vitest'

// Only the pure rules are under test: keep the service and the store hooks out.
vi.mock('@/services/AdminActionService', () => ({ adminActionService: {} }))
vi.mock('@/hooks/use-hachiman', () => ({ useRoleCeiling: () => 0 }))

const { SWATCHES, canMoveHigher, canMoveLower, colourFromHex, isCustomColour, reorderBody } =
  await import('./use-role-list')

/** Movable roles, highest first: Captain 4, Shotcallers 3, Squad 2, Bots 1. */
const ROLES = [
  { id: 'captain', position: 4 },
  { id: 'shot', position: 3 },
  { id: 'squad', position: 2 },
  { id: 'bots', position: 1 }
]

describe('canMoveHigher / canMoveLower', () => {
  it('lets an admin (no ceiling) move every role but past the ends', () => {
    expect(ROLES.map((_, i) => canMoveHigher(ROLES, i, Infinity))).toEqual([
      false,
      true,
      true,
      true
    ])
    expect(ROLES.map((_, i) => canMoveLower(ROLES, i, Infinity))).toEqual([true, true, true, false])
  })

  it('keeps a role under the ceiling from moving up past it', () => {
    // My highest role is Shotcallers (3): Squad cannot move above it, Shotcallers cannot move.
    expect(canMoveHigher(ROLES, 2, 3)).toBe(false)
    expect(canMoveHigher(ROLES, 1, 3)).toBe(false)
    expect(canMoveLower(ROLES, 1, 3)).toBe(false)
    expect(canMoveHigher(ROLES, 3, 3)).toBe(true)
    expect(canMoveLower(ROLES, 2, 3)).toBe(true)
  })

  it('says no for a role that is not in the list', () => {
    expect(canMoveHigher(ROLES, -1, Infinity)).toBe(false)
    expect(canMoveLower(ROLES, -1, Infinity)).toBe(false)
  })
})

describe('reorderBody', () => {
  it('swaps the positions of two neighbours', () => {
    expect(reorderBody(ROLES, 2, 1, Infinity)).toEqual([
      { id: 'squad', position: 3 },
      { id: 'shot', position: 2 }
    ])
  })

  it('moves a role over several places and leaves the others out', () => {
    expect(reorderBody(ROLES, 3, 0, Infinity)).toEqual([
      { id: 'bots', position: 4 },
      { id: 'captain', position: 3 },
      { id: 'shot', position: 2 },
      { id: 'squad', position: 1 }
    ])
    expect(reorderBody(ROLES, 0, 1, Infinity)).toEqual([
      { id: 'shot', position: 4 },
      { id: 'captain', position: 3 }
    ])
  })

  it('reuses the positions of the span, also when they have gaps', () => {
    const gaps = [
      { id: 'a', position: 10 },
      { id: 'b', position: 7 },
      { id: 'c', position: 2 }
    ]
    expect(reorderBody(gaps, 2, 1, Infinity)).toEqual([
      { id: 'c', position: 7 },
      { id: 'b', position: 2 }
    ])
  })

  it('refuses a move that touches a role at or above the ceiling', () => {
    expect(reorderBody(ROLES, 2, 1, 3)).toBeNull()
    expect(reorderBody(ROLES, 3, 2, 3)).toEqual([
      { id: 'bots', position: 2 },
      { id: 'squad', position: 1 }
    ])
  })

  it('refuses a no-op or an index out of range', () => {
    expect(reorderBody(ROLES, 1, 1, Infinity)).toBeNull()
    expect(reorderBody(ROLES, 0, -1, Infinity)).toBeNull()
    expect(reorderBody(ROLES, 3, 4, Infinity)).toBeNull()
    expect(reorderBody(ROLES, -1, 0, Infinity)).toBeNull()
  })

  it('renumbers n..1 when positions repeat (legacy data)', () => {
    const dup = [
      { id: 'a', position: 2 },
      { id: 'b', position: 2 },
      { id: 'c', position: 1 }
    ]
    // a keeps position 2, so only c and b are sent.
    expect(reorderBody(dup, 2, 0, Infinity)).toEqual([
      { id: 'c', position: 3 },
      { id: 'b', position: 1 }
    ])
  })
})

describe('colours', () => {
  it('treats a set colour outside the swatches as custom', () => {
    expect(isCustomColour(0)).toBe(false)
    expect(SWATCHES.every((c) => !isCustomColour(c))).toBe(true)
    expect(isCustomColour(0x123456)).toBe(true)
  })

  it('reads the value of a colour input', () => {
    expect(colourFromHex('#ffc36b')).toBe(0xffc36b)
    expect(colourFromHex('#000001')).toBe(1)
  })
})
