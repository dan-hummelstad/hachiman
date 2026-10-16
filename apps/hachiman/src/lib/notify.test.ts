import { describe, expect, it } from 'vitest'
import {
  guildNotifyLevel,
  isFollowing,
  messageNotifyKind,
  notifyLevel,
  notifyLevelLabel,
  type NotifyPrefs
} from './notify'

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

describe('notifyLevelLabel', () => {
  it('names each level once', () => {
    expect(notifyLevelLabel('all')).toBe('All messages')
    expect(notifyLevelLabel('mentions')).toBe('Mentions only')
    expect(notifyLevelLabel('none')).toBe('Nothing')
  })

  it('names the default level of a guild with no setting', () => {
    expect(notifyLevelLabel(guildNotifyLevel(prefs({}), 'g'))).toBe('Mentions only')
  })
})

describe('isFollowing', () => {
  it('counts only a channel set to all, not a guild set to all', () => {
    expect(isFollowing(prefs({ g: 'all' }), 'c')).toBe(false)
    expect(isFollowing(prefs({ c: 'all' }), 'c')).toBe(true)
    expect(isFollowing(prefs({ c: 'mentions' }), 'c')).toBe(false)
  })
})

describe('messageNotifyKind', () => {
  it('a DM is dm, a guild mention is mention, else channel', () => {
    expect(messageNotifyKind(null, false)).toBe('dm')
    expect(messageNotifyKind(null, true)).toBe('dm')
    expect(messageNotifyKind('g', true)).toBe('mention')
    expect(messageNotifyKind('g', false)).toBe('channel')
  })
})
