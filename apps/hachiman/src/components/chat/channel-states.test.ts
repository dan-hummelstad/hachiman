import { describe, expect, it } from 'vitest'
import type { Role } from '@hachiman/client'
import { cantPostReason, chipRoles, hasTitleChip } from './channel-states'

describe('cantPostReason', () => {
  it('keeps the desktop texts', () => {
    expect(cantPostReason('#patch-notes', true, ['vexbot', 'Captains'], false)).toBe(
      "You can't post in #patch-notes. Only vexbot and Captains can."
    )
    expect(cantPostReason('#patch-notes', true, [], false)).toBe("You can't post in #patch-notes.")
    expect(cantPostReason('#general', false, [], false)).toBe(
      "You don't have permission to send messages in #general."
    )
  })

  it('gives the shorter mobile texts (M62)', () => {
    expect(cantPostReason('#patch-notes', true, ['vexbot', 'Captains'], true)).toBe(
      'Only vexbot and Captains can post in #patch-notes.'
    )
    expect(cantPostReason('#patch-notes', true, ['A', 'B', 'C'], true)).toBe(
      'Only A, B and C can post in #patch-notes.'
    )
    expect(cantPostReason('#patch-notes', true, [], true)).toBe("You can't post in #patch-notes.")
    expect(cantPostReason('#general', false, ['ignored'], true)).toBe(
      "You can't send messages in #general."
    )
  })
})

describe('chipRoles', () => {
  it('names at most two roles and counts the rest', () => {
    expect(chipRoles([])).toEqual({ shown: [], more: 0 })
    expect(chipRoles(['Lead'])).toEqual({ shown: ['Lead'], more: 0 })
    expect(chipRoles(['Lead', 'Engineering'])).toEqual({ shown: ['Lead', 'Engineering'], more: 0 })
    expect(chipRoles(['Lead', 'Engineering', 'Bots', 'Ops'])).toEqual({
      shown: ['Lead', 'Engineering'],
      more: 2
    })
  })
})

describe('hasTitleChip', () => {
  const access = { readOnly: false, posters: [], restricted: false, viewers: [] }
  const role = { id: 'r1', name: 'Engineering' } as Role
  it('is set for read only and for restricted with roles', () => {
    expect(hasTitleChip(access)).toBe(false)
    expect(hasTitleChip({ ...access, readOnly: true })).toBe(true)
    expect(hasTitleChip({ ...access, restricted: true })).toBe(false)
    expect(hasTitleChip({ ...access, restricted: true, viewers: [role] })).toBe(true)
  })
})
