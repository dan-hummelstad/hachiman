import { describe, expect, it } from 'vitest'
import { Permissions, type Channel, type Role } from '@hachiman/client'
import { channelAccess, joinNames } from './channel-access'

const G = 'g1'
const role = (id: string, name: string, position: number, permissions: number): Role => ({
  id,
  guildId: G,
  name,
  color: 0,
  hoist: false,
  position,
  permissions
})
const EVERYONE = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES
const roles = new Map<string, Role>([
  [G, role(G, '@everyone', 0, EVERYONE)],
  ['admin', role('admin', 'Captain', 3, Permissions.ADMINISTRATOR)],
  ['lead', role('lead', 'Lead', 2, 0)],
  ['eng', role('eng', 'Engineering', 1, 0)]
])
const channel = (overwrites: Channel['permissionOverwrites']): Channel => ({
  id: 'c1',
  guildId: G,
  type: 'text',
  name: 'x',
  topic: null,
  parentId: null,
  position: 0,
  permissionOverwrites: overwrites,
  mlsGroupId: null,
  historyVisibility: null
})

describe('channelAccess', () => {
  it('is open without overwrites', () => {
    expect(channelAccess(channel([]), roles)).toMatchObject({ readOnly: false, restricted: false })
  })

  it('reads a channel where @everyone cannot send as read only, with the roles that can', () => {
    const a = channelAccess(
      channel([
        { id: G, type: 'role', allow: 0, deny: Permissions.SEND_MESSAGES },
        { id: 'lead', type: 'role', allow: Permissions.SEND_MESSAGES, deny: 0 }
      ]),
      roles
    )
    expect(a.readOnly).toBe(true)
    expect(a.posters.map((r) => r.name)).toEqual(['Captain', 'Lead'])
  })

  it('lists the roles that can see a restricted channel', () => {
    const a = channelAccess(
      channel([
        { id: G, type: 'role', allow: 0, deny: Permissions.VIEW_CHANNEL },
        { id: 'eng', type: 'role', allow: Permissions.VIEW_CHANNEL, deny: 0 }
      ]),
      roles
    )
    expect(a).toMatchObject({ restricted: true, readOnly: false })
    expect(a.viewers.map((r) => r.name)).toEqual(['Captain', 'Engineering'])
  })

  it('joins names', () => {
    expect(joinNames(['a', 'b', 'c'])).toBe('a, b and c')
  })
})
