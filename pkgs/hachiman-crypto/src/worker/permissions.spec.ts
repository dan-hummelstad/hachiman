import { ALL_PERMISSIONS, Permissions } from '@hachiman/client/permissions'
import { describe, expect, it } from 'vitest'

import type { AdminReplayState } from '../api'
import { clientPermissions as p } from './permissions'

const G = 'guild'
const OWNER = 'owner'
const MOD = 'mod-user'
const ADMIN = 'admin-user'
const PLAIN = 'plain-user'
const GUEST = 'guest-user'
const OUTSIDER = 'outsider'
const SECRET = 'secret-channel'
const OPEN = 'open-channel'
const MEMBERS = [OWNER, MOD, ADMIN, PLAIN, GUEST]

const everyone = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES

const state: AdminReplayState = {
  guildId: G,
  seq: 5,
  headHash: new Uint8Array(32),
  ownerId: OWNER,
  roles: [
    { id: G, permissions: everyone, position: 0 },
    { id: 'helper', permissions: Permissions.KICK_MEMBERS, position: 1 },
    { id: 'mod', permissions: Permissions.MANAGE_ROLES | Permissions.MANAGE_CHANNELS, position: 2 },
    { id: 'admin', permissions: Permissions.ADMINISTRATOR, position: 3 },
  ],
  overwrites: [
    { channelId: SECRET, targetId: G, targetType: 'role', allow: 0, deny: Permissions.VIEW_CHANNEL },
    { channelId: SECRET, targetId: 'mod', targetType: 'role', allow: Permissions.VIEW_CHANNEL, deny: 0 },
    { channelId: SECRET, targetId: GUEST, targetType: 'member', allow: Permissions.VIEW_CHANNEL, deny: Permissions.SEND_MESSAGES },
  ],
  memberRoles: [
    { userId: MOD, roleIds: ['mod'] },
    { userId: ADMIN, roleIds: ['admin'] },
  ],
  historyVisibility: [],
}

describe('AdminPermissionModel over @hachiman/client/permissions', () => {
  it('computes guild permissions from the replayed roles', () => {
    expect(p.guildPermissions(state, OWNER)).toBe(ALL_PERMISSIONS)
    expect(p.guildPermissions(state, ADMIN)).toBe(ALL_PERMISSIONS)
    expect(p.guildPermissions(state, MOD)).toBe(everyone | Permissions.MANAGE_ROLES | Permissions.MANAGE_CHANNELS)
    expect(p.guildPermissions(state, PLAIN)).toBe(everyone)
  })

  it('applies the channel overwrites: @everyone, then roles, then the member', () => {
    expect(p.channelPermissions(state, OPEN, PLAIN, MEMBERS)).toBe(everyone)
    expect(p.channelPermissions(state, SECRET, PLAIN, MEMBERS)).toBe(0)
    expect(p.channelPermissions(state, SECRET, MOD, MEMBERS) & Permissions.VIEW_CHANNEL).toBe(Permissions.VIEW_CHANNEL)
    expect(p.channelPermissions(state, SECRET, GUEST, MEMBERS)).toBe(Permissions.VIEW_CHANNEL)
    expect(p.channelPermissions(state, SECRET, ADMIN, MEMBERS)).toBe(ALL_PERMISSIONS)
    expect(p.channelPermissions(state, SECRET, OWNER, MEMBERS)).toBe(ALL_PERMISSIONS)
  })

  it('gives a user outside the guild no channel permission', () => {
    expect(p.channelPermissions(state, OPEN, OUTSIDER, MEMBERS)).toBe(0)
    expect(p.channelPermissions(state, OPEN, PLAIN, [OWNER])).toBe(0)
  })

  it('gives @everyone alone: the @everyone overwrite applies, role and member overwrites do not', () => {
    expect(p.everyoneChannelPermissions(state, OPEN)).toBe(everyone)
    expect(p.everyoneChannelPermissions(state, SECRET)).toBe(0)
    // A role overwrite that denies does not reach a member without that role.
    const denied: AdminReplayState = { ...state, overwrites: [{ channelId: OPEN, targetId: 'helper', targetType: 'role', allow: 0, deny: Permissions.VIEW_CHANNEL }] }
    expect(p.everyoneChannelPermissions(denied, OPEN)).toBe(everyone)
    // A member overwrite never applies, whatever its target id.
    const member: AdminReplayState = { ...state, overwrites: [{ channelId: OPEN, targetId: G, targetType: 'member', allow: 0, deny: Permissions.VIEW_CHANNEL }] }
    expect(p.everyoneChannelPermissions(member, OPEN)).toBe(everyone)
    const adminEveryone: AdminReplayState = { ...state, roles: [{ id: G, permissions: Permissions.ADMINISTRATOR, position: 0 }] }
    expect(p.everyoneChannelPermissions(adminEveryone, SECRET)).toBe(ALL_PERMISSIONS)
  })

  it('checks the role hierarchy strictly', () => {
    for (const r of [G, 'helper', 'mod', 'admin']) expect(p.outranks(state, OWNER, r)).toBe(true)
    expect(p.outranks(state, MOD, 'helper')).toBe(true)
    expect(p.outranks(state, MOD, G)).toBe(true)
    expect(p.outranks(state, MOD, 'mod')).toBe(false)
    expect(p.outranks(state, MOD, 'admin')).toBe(false)
    expect(p.outranks(state, PLAIN, 'helper')).toBe(false)
    expect(p.outranks(state, PLAIN, G)).toBe(false)
    expect(p.outranks(state, ADMIN, 'unknown-role')).toBe(false)
  })
})
