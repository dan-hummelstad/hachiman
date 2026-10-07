import { describe, expect, it } from 'vitest'
import { DEFAULT_EVERYONE, Permissions, type Channel } from '@hachiman/client'
import { channelAccess } from './channel-access'

const G = 'g1'
const ch = (
  type: Channel['type'],
  overwrites: Channel['permissionOverwrites'] = []
): Pick<Channel, 'type' | 'permissionOverwrites'> => ({ type, permissionOverwrites: overwrites })

describe('channelAccess', () => {
  it('marks nothing on an open channel', () => {
    expect(channelAccess(ch('text'), G, DEFAULT_EVERYONE)).toEqual({
      readOnly: false,
      restricted: false
    })
  })

  it('marks a text channel where @everyone cannot send as read only', () => {
    const c = ch('text', [{ id: G, type: 'role', allow: 0, deny: Permissions.SEND_MESSAGES }])
    expect(channelAccess(c, G, DEFAULT_EVERYONE)).toEqual({ readOnly: true, restricted: false })
  })

  it('marks a channel hidden from @everyone as restricted, not read only', () => {
    const c = ch('text', [
      { id: G, type: 'role', allow: 0, deny: Permissions.VIEW_CHANNEL },
      { id: 'r-eng', type: 'role', allow: Permissions.VIEW_CHANNEL, deny: 0 }
    ])
    expect(channelAccess(c, G, DEFAULT_EVERYONE)).toEqual({ readOnly: false, restricted: true })
  })

  it('ignores overwrites of other roles', () => {
    const c = ch('text', [{ id: 'r-x', type: 'role', allow: 0, deny: Permissions.SEND_MESSAGES }])
    expect(channelAccess(c, G, DEFAULT_EVERYONE).readOnly).toBe(false)
  })

  it('never marks a voice channel read only', () => {
    const perms = DEFAULT_EVERYONE & ~Permissions.SEND_MESSAGES
    expect(channelAccess(ch('voice'), G, perms).readOnly).toBe(false)
  })
})
