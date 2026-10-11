import { describe, expect, it } from 'vitest'
import { occupantDetail, othersInCallText } from './voice-occupant-text'

const QUIET = { selfStream: false, selfMute: false, selfDeaf: false, mute: false, deaf: false }

describe('occupantDetail', () => {
  it('says nothing for a person who only sits in the call', () => {
    expect(occupantDetail(QUIET)).toBeNull()
  })

  it('reads the M64 row: sharing and muted', () => {
    expect(occupantDetail({ ...QUIET, selfStream: true, selfMute: true })).toBe(
      'Sharing screen · muted'
    )
  })

  it('capitalises the first part only', () => {
    expect(occupantDetail({ ...QUIET, selfMute: true })).toBe('Muted')
    expect(occupantDetail({ ...QUIET, selfMute: true, selfDeaf: true })).toBe('Muted · deafened')
  })

  it('names a server mute or deafen in place of the own one', () => {
    expect(occupantDetail({ ...QUIET, mute: true, selfMute: true })).toBe('Server muted')
    expect(occupantDetail({ ...QUIET, deaf: true, selfDeaf: true, selfMute: true })).toBe(
      'Muted · server deafened'
    )
  })
})

describe('othersInCallText', () => {
  it('is null when no one else is in the call', () => {
    expect(othersInCallText([])).toBeNull()
  })

  it('uses "is" for one person and "are" for more', () => {
    expect(othersInCallText(['yuki.h'])).toBe('yuki.h is in the call')
    expect(othersInCallText(['yuki.h', 'renata'])).toBe('yuki.h and renata are in the call')
  })

  it('names three people (M64)', () => {
    expect(othersInCallText(['yuki.h', 'renata', 'tobias'])).toBe(
      'yuki.h, renata and tobias are in the call'
    )
  })

  it('names two and counts the rest past three', () => {
    expect(othersInCallText(['yuki.h', 'renata', 'tobias', 'juni'])).toBe(
      'yuki.h, renata and 2 others are in the call'
    )
    expect(othersInCallText(['a', 'b', 'c', 'd', 'e', 'f'])).toBe(
      'a, b and 4 others are in the call'
    )
  })
})
