import { describe, expect, it } from 'vitest'
import type { Channel, User } from '@hachiman/client'
import { hasRightDrawer } from './drawer-state'

const user = { id: 'u2', username: 'bo' } as User
const channel = (c: Partial<Channel>): Channel => ({ id: 'c1', guildId: null, ...c }) as Channel

describe('hasRightDrawer', () => {
  it('has the column of a guild channel', () => {
    expect(hasRightDrawer(channel({ guildId: 'g1', type: 'text' }))).toBe(true)
    expect(hasRightDrawer(channel({ guildId: 'g1', type: 'pages' }))).toBe(true)
  })

  it('has the profile of a 1:1 DM', () => {
    expect(hasRightDrawer(channel({ type: 'dm', recipients: [user] }))).toBe(true)
  })

  it('has nothing for a DM with no recipient', () => {
    expect(hasRightDrawer(channel({ type: 'dm', recipients: [] }))).toBe(false)
    expect(hasRightDrawer(channel({ type: 'dm' }))).toBe(false)
  })

  it('has nothing for a group DM', () => {
    expect(hasRightDrawer(channel({ type: 'group_dm', recipients: [user, user] }))).toBe(false)
  })
})
