import { Permissions, type Channel } from '@hachiman/client'
import { describe, expect, it } from 'vitest'
import { inviteExpiryChoices, inviteScope, isInviteExpiryChoice, sortInvites } from './invites'

describe('inviteExpiryChoices', () => {
  it('gives a member without ADMINISTRATOR at most 24 hours and no permanent invite', () => {
    const seconds = inviteExpiryChoices(false).map((c) => c.seconds)
    expect(Math.max(...seconds)).toBe(86400)
    expect(seconds).not.toContain(0)
  })

  it('gives an administrator 7 days and a permanent invite too', () => {
    const choices = inviteExpiryChoices(true)
    expect(choices.map((c) => c.seconds)).toEqual([
      ...inviteExpiryChoices(false).map((c) => c.seconds),
      604800,
      0
    ])
    expect(choices.find((c) => c.seconds === 0)?.label).toBe('Permanent')
  })
})

describe('isInviteExpiryChoice', () => {
  it('rejects 7 days and permanent once the user is not an administrator', () => {
    for (const seconds of [604800, 0]) {
      expect(isInviteExpiryChoice(seconds, true)).toBe(true)
      expect(isInviteExpiryChoice(seconds, false)).toBe(false)
    }
    expect(isInviteExpiryChoice(86400, false)).toBe(true)
    expect(isInviteExpiryChoice(12345, true)).toBe(false)
  })
})

describe('sortInvites', () => {
  it('puts permanent invites first and keeps the order otherwise', () => {
    const list = [
      { code: 'a', expiresAt: '2026-10-07T00:00:00Z' },
      { code: 'b', expiresAt: null },
      { code: 'c', expiresAt: '2026-10-06T00:00:00Z' },
      { code: 'd', expiresAt: null }
    ]
    expect(sortInvites(list).map((i) => i.code)).toEqual(['b', 'd', 'a', 'c'])
    expect(list.map((i) => i.code)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('inviteScope', () => {
  const guild = { id: 'g', ownerId: 'owner' }
  const VIEW = Permissions.VIEW_CHANNEL
  const channel = (id: string, over: Partial<Channel> = {}): Channel => ({
    id,
    guildId: 'g',
    type: 'text',
    name: id,
    topic: null,
    parentId: null,
    position: 0,
    permissionOverwrites: [],
    mlsGroupId: null,
    historyVisibility: 'shared',
    ...over
  })
  const roles = new Map([
    ['g', { id: 'g', permissions: VIEW }],
    ['mods', { id: 'mods', permissions: VIEW | Permissions.MANAGE_GUILD }]
  ])

  it('lists the text and pages channels that @everyone can view, in sidebar order', () => {
    const scope = inviteScope(guild, roles, [
      channel('rules', { position: 2 }),
      channel('docs', { type: 'pages', position: 1 }),
      channel('lounge', { type: 'voice' }),
      channel('cat', { type: 'category' }),
      channel('other-guild', { guildId: 'h' }),
      channel('mods-only', {
        permissionOverwrites: [
          { id: 'g', type: 'role', allow: 0, deny: VIEW },
          { id: 'mods', type: 'role', allow: VIEW, deny: 0 }
        ]
      }),
      channel('owner-only', {
        permissionOverwrites: [
          { id: 'g', type: 'role', allow: 0, deny: VIEW },
          { id: 'owner', type: 'member', allow: VIEW, deny: 0 }
        ]
      })
    ])
    expect(scope.map((c) => c.id)).toEqual(['docs', 'rules'])
  })

  it('follows an @everyone overwrite that opens a channel', () => {
    const closed = new Map([['g', { id: 'g', permissions: 0 }]])
    const open = channel('open', {
      permissionOverwrites: [{ id: 'g', type: 'role', allow: VIEW, deny: 0 }]
    })
    expect(inviteScope(guild, closed, [channel('a'), open]).map((c) => c.id)).toEqual(['open'])
  })
})
