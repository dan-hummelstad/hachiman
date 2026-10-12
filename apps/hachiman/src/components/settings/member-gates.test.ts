import { Permissions, type Member, type Role } from '@hachiman/client'
import { describe, expect, it } from 'vitest'
import {
  assignableRoles,
  filterMembers,
  kickCopy,
  memberGate,
  membersLine,
  toggleRole
} from './member-gates'

const GUILD = 'g1'

function member(id: string, username: string, nick: string | null = null): Member {
  return {
    guildId: GUILD,
    user: { id, username, avatar: null },
    nick,
    roles: [],
    joinedAt: '2026-01-01T00:00:00Z',
    mute: false,
    deaf: false
  }
}

function role(id: string, position: number): Role {
  return { id, guildId: GUILD, name: id, color: 0, hoist: false, position, permissions: 0 }
}

describe('memberGate', () => {
  const me = { myId: 'me', ownerId: 'owner' }

  it('lets a member change only their own nickname with CHANGE_NICKNAME', () => {
    const perms = Permissions.CHANGE_NICKNAME
    expect(memberGate('me', { ...me, perms })).toEqual({
      isSelf: true,
      isOwner: false,
      canNick: true,
      canKick: false
    })
    expect(memberGate('other', { ...me, perms }).canNick).toBe(false)
  })

  it('needs MANAGE_NICKNAMES for the nickname of someone else', () => {
    const perms = Permissions.MANAGE_NICKNAMES
    expect(memberGate('other', { ...me, perms }).canNick).toBe(true)
    expect(memberGate('me', { ...me, perms }).canNick).toBe(false)
  })

  it('never offers Kick on the owner or on me', () => {
    const perms = Permissions.KICK_MEMBERS
    expect(memberGate('other', { ...me, perms }).canKick).toBe(true)
    expect(memberGate('owner', { ...me, perms })).toMatchObject({ isOwner: true, canKick: false })
    expect(memberGate('me', { ...me, perms }).canKick).toBe(false)
    expect(memberGate('other', { ...me, perms: 0 }).canKick).toBe(false)
  })

  it('treats no signed-in user as nobody', () => {
    expect(memberGate('other', { perms: 0, myId: undefined, ownerId: 'owner' }).isSelf).toBe(false)
  })
})

describe('assignableRoles', () => {
  it('keeps the roles under my ceiling, highest first, and never @everyone', () => {
    const roles = [role(GUILD, 0), role('low', 1), role('mid', 3), role('top', 5), role('mine', 4)]
    expect(assignableRoles(roles, GUILD, 4).map((r) => r.id)).toEqual(['mid', 'low'])
  })

  it('gives every role but @everyone under an infinite ceiling (the owner or an administrator)', () => {
    const roles = [role(GUILD, 0), role('a', 1), role('b', 2)]
    expect(assignableRoles(roles, GUILD, Infinity).map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('filterMembers', () => {
  const list = [member('1', 'juniper', 'Juni'), member('2', 'kestrel'), member('3', 'marlowe')]

  it('returns the same list for an empty or blank query', () => {
    expect(filterMembers(list, '')).toBe(list)
    expect(filterMembers(list, '   ')).toBe(list)
  })

  it('matches the nickname and the username, in any case', () => {
    expect(filterMembers(list, 'JUNI').map((m) => m.user.id)).toEqual(['1'])
    expect(filterMembers(list, 'niper').map((m) => m.user.id)).toEqual(['1'])
    expect(filterMembers(list, ' e ').map((m) => m.user.id)).toEqual(['1', '2', '3'])
    expect(filterMembers(list, 'zzz')).toEqual([])
  })
})

describe('toggleRole', () => {
  it('adds a missing role and takes a present one away, without changing the input', () => {
    const roles = ['a', 'b']
    expect(toggleRole(roles, 'c')).toEqual(['a', 'b', 'c'])
    expect(toggleRole(roles, 'a')).toEqual(['b'])
    expect(roles).toEqual(['a', 'b'])
  })
})

describe('membersLine', () => {
  it('counts members and online members', () => {
    expect(membersLine(12, 9)).toBe('12 members · 9 online')
    expect(membersLine(1, 0)).toBe('1 member · 0 online')
  })
})

describe('kickCopy', () => {
  it('names the member in the title and in the error phrase', () => {
    expect(kickCopy('ozzy')).toEqual({
      title: 'Kick ozzy?',
      body: 'They leave the guild now. They can come back with a new invite.',
      what: 'kick ozzy'
    })
  })
})
