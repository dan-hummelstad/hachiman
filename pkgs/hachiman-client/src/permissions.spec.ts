import { describe, expect, it } from 'vitest'
import {
  ALL,
  computeBasePermissions,
  computeChannelPermissions,
  DEFAULT_EVERYONE,
  DM_PERMISSIONS,
  effectivePermissions,
  has,
  Permissions as P,
  permissionChannel,
} from './permissions'
import type { Channel, PermissionOverwrite } from './types'

const guild = { id: 'g', ownerId: 'owner' }
const roles = new Map([
  ['g', { id: 'g', permissions: DEFAULT_EVERYONE }],
  ['mod', { id: 'mod', permissions: P.MANAGE_MESSAGES | P.KICK_MEMBERS }],
  ['admin', { id: 'admin', permissions: P.ADMINISTRATOR }],
  ['muted', { id: 'muted', permissions: 0 }],
])
const member = (id: string, r: string[] = []) => ({ user: { id }, roles: r })
const chan = (ow: PermissionOverwrite[]) => ({ permissionOverwrites: ow })
const ow = (id: string, type: 'role' | 'member', allow: number, deny: number) => ({ id, type, allow, deny })

describe('computeBasePermissions', () => {
  it.each([
    ['owner gets ALL', member('owner'), ALL],
    ['@everyone only', member('u'), DEFAULT_EVERYONE],
    ['roles OR together', member('u', ['mod']), DEFAULT_EVERYONE | P.MANAGE_MESSAGES | P.KICK_MEMBERS],
    ['ADMINISTRATOR ⇒ ALL', member('u', ['admin']), ALL],
    ['unknown role ignored', member('u', ['nope']), DEFAULT_EVERYONE],
  ])('%s', (_, m, want) => {
    expect(computeBasePermissions(guild, m, roles)).toBe(want)
  })
})

describe('computeChannelPermissions', () => {
  const noSend = ow('g', 'role', 0, P.SEND_MESSAGES)
  it.each([
    ['no overwrites = base', member('u'), [], DEFAULT_EVERYONE],
    ['@everyone deny', member('u'), [noSend], DEFAULT_EVERYONE & ~P.SEND_MESSAGES],
    [
      'role allow beats @everyone deny',
      member('u', ['mod']),
      [noSend, ow('mod', 'role', P.SEND_MESSAGES, 0)],
      DEFAULT_EVERYONE | P.MANAGE_MESSAGES | P.KICK_MEMBERS,
    ],
    [
      'role allow wins over another role deny',
      member('u', ['mod', 'muted']),
      [ow('mod', 'role', P.SPEAK, 0), ow('muted', 'role', 0, P.SPEAK)],
      DEFAULT_EVERYONE | P.MANAGE_MESSAGES | P.KICK_MEMBERS,
    ],
    [
      'member overwrite beats role',
      member('u', ['mod']),
      [ow('mod', 'role', 0, P.CONNECT), ow('u', 'member', P.CONNECT, 0)],
      DEFAULT_EVERYONE | P.MANAGE_MESSAGES | P.KICK_MEMBERS,
    ],
    ['no VIEW_CHANNEL ⇒ 0', member('u'), [ow('g', 'role', 0, P.VIEW_CHANNEL)], 0],
    [
      'overwrite for a role not held is ignored',
      member('u'),
      [ow('mod', 'role', P.MANAGE_ROLES, 0)],
      DEFAULT_EVERYONE,
    ],
    ['admin ignores overwrites', member('u', ['admin']), [ow('g', 'role', 0, P.VIEW_CHANNEL)], ALL],
    ['owner ignores overwrites', member('owner'), [ow('owner', 'member', 0, P.VIEW_CHANNEL)], ALL],
  ] as const)('%s', (_, m, ows, want) => {
    expect(computeChannelPermissions(guild, m, roles, chan([...ows]))).toBe(want)
  })

  it('has() needs every bit', () => {
    expect(has(P.SEND_MESSAGES | P.VIEW_CHANNEL, P.SEND_MESSAGES)).toBe(true)
    expect(has(P.SEND_MESSAGES, P.SEND_MESSAGES | P.VIEW_CHANNEL)).toBe(false)
  })
})

describe('effectivePermissions', () => {
  const muted = chan([ow('g', 'role', 0, P.SEND_MESSAGES)])
  it.each([
    ['DM channel ⇒ DM_PERMISSIONS', {}, { guildId: null, ...chan([]) }, DM_PERMISSIONS],
    ['unknown guild ⇒ 0', { member: member('u'), roles }, undefined, 0],
    ['unknown member ⇒ 0', { guild, roles }, { guildId: 'g', ...muted }, 0],
    ['no channel ⇒ base', { guild, member: member('u'), roles }, undefined, DEFAULT_EVERYONE],
    [
      'channel ⇒ overwrites applied',
      { guild, member: member('u'), roles },
      { guildId: 'g', ...muted },
      DEFAULT_EVERYONE & ~P.SEND_MESSAGES,
    ],
    ['no roles known ⇒ owner still ALL', { guild, member: member('owner') }, undefined, ALL],
  ])('%s', (_, ctx, channel, want) => {
    expect(effectivePermissions({ ...ctx, channel })).toBe(want)
  })
})

describe('permissionChannel', () => {
  type C = Pick<Channel, 'id' | 'type' | 'parentId'>
  const parent: C = { id: 'p', type: 'text', parentId: null }
  const thread: C = { id: 't', type: 'thread', parentId: 'p' }
  const lookup = (id: string): C | undefined => (id === 'p' ? parent : undefined)
  it('a thread resolves to its parent', () => expect(permissionChannel(thread, lookup)).toBe(parent))
  it('another type resolves to itself', () => expect(permissionChannel(parent, lookup)).toBe(parent))
  it('a thread with an unknown parent resolves to null', () =>
    expect(permissionChannel({ ...thread, parentId: 'x' }, lookup)).toBeNull())
})
