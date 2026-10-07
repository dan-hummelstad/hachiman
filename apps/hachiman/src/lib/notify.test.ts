import { describe, expect, it } from 'vitest'
import { guildNotifyLevel, isFollowing, notifyLevel, type NotifyPrefs } from './notify'

const prefs = (notify: NotifyPrefs['notify']): NotifyPrefs => ({ notify, muted: [] })

describe('notify levels', () => {
  it('defaults a guild to mentions and a DM to all', () => {
    expect(guildNotifyLevel(prefs({}), 'g')).toBe('mentions')
    expect(notifyLevel(prefs({}), 'c', 'g')).toBe('mentions')
    expect(notifyLevel(prefs({}), 'd', null)).toBe('all')
  })

  it('lets the channel level win over the guild level', () => {
    expect(notifyLevel(prefs({ g: 'all', c: 'none' }), 'c', 'g')).toBe('none')
    expect(notifyLevel(prefs({ g: 'all' }), 'c', 'g')).toBe('all')
  })
})

describe('isFollowing', () => {
  it('counts only a channel set to all, not a guild set to all', () => {
    expect(isFollowing(prefs({ g: 'all' }), 'c')).toBe(false)
    expect(isFollowing(prefs({ c: 'all' }), 'c')).toBe(true)
    expect(isFollowing(prefs({ c: 'mentions' }), 'c')).toBe(false)
  })
})
