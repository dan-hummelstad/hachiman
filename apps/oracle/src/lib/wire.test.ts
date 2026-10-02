/**
 * Unit tests for the pure wire helpers: GuildFull assembly (per-viewer
 * channel visibility via the shared permission algorithm) and the messages
 * query parser. No DB / Redis.
 *
 * Run with `tsx src/lib/wire.test.ts` (part of `pnpm -F @hachiman/oracle test`).
 */
import assert from 'node:assert/strict'

import { DEFAULT_EVERYONE, Permissions } from '@hachiman/client/permissions'

import type { ChannelRow, GuildMemberRow, PermissionOverwriteRow, RoleRow } from '@/db/schema'
import { assembleGuildFull, parseMessageQuery, toUser, type GuildFullInput } from './wire'

// --- tiny test harness ------------------------------------------------------
let passed = 0
const failures: string[] = []
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
  } catch (err) {
    failures.push(`${name}\n    ${(err as Error).message.replace(/\n/g, '\n    ')}`)
  }
}

// --- fixtures ---------------------------------------------------------------
const T = new Date('2026-09-30T12:00:00Z')
const GUILD = '00000000-0000-4000-8000-000000000001'
const OWNER = '00000000-0000-4000-8000-0000000000a1'
const ALICE = '00000000-0000-4000-8000-0000000000a2'
const MOD_ROLE = '00000000-0000-4000-8000-0000000000b1'
const GENERAL = '00000000-0000-4000-8000-0000000000c1'
const STAFF = '00000000-0000-4000-8000-0000000000c2'

function user(id: string, displayName: string) {
  return { id, displayName, name: null, email: `${displayName}@example.com`, image: null }
}
function member(userId: string): GuildMemberRow {
  return { guildId: GUILD, userId, nick: null, joinedAt: T }
}
function channel(id: string, name: string): ChannelRow {
  return {
    id,
    guildId: GUILD,
    type: 'text',
    name,
    topic: null,
    parentId: null,
    position: 0,
    ownerId: null,
    createdAt: T,
  }
}
function role(id: string, position: number, permissions: number): RoleRow {
  return { id, guildId: GUILD, name: id === GUILD ? '@everyone' : 'role', color: 0, position, permissions }
}
function overwrite(
  channelId: string,
  targetId: string,
  targetType: 'role' | 'member',
  allow: number,
  deny: number,
): PermissionOverwriteRow {
  return { channelId, targetId, targetType, allow, deny }
}

// #staff: hidden from @everyone, visible to the mod role.
function input(viewerId: string, aliceRoles: string[]): GuildFullInput {
  return {
    guild: { id: GUILD, ownerId: OWNER, name: 'G', icon: null, banner: null, region: null, createdAt: T },
    roles: [role(GUILD, 0, DEFAULT_EVERYONE), role(MOD_ROLE, 1, 0)],
    channels: [channel(GENERAL, 'general'), channel(STAFF, 'staff')],
    overwrites: [
      overwrite(STAFF, GUILD, 'role', 0, Permissions.VIEW_CHANNEL),
      overwrite(STAFF, MOD_ROLE, 'role', Permissions.VIEW_CHANNEL, 0),
    ],
    members: [
      { member: member(OWNER), user: user(OWNER, 'owner') },
      { member: member(ALICE), user: user(ALICE, 'alice') },
    ],
    memberRoles: aliceRoles.map((roleId) => ({ userId: ALICE, roleId })),
    viewerId,
    voiceStates: [],
    presences: [],
  }
}

const names = (g: ReturnType<typeof assembleGuildFull>) => g.channels.map((c) => c.name)

// --- GuildFull --------------------------------------------------------------
test('owner sees every channel regardless of overwrites', () => {
  assert.deepEqual(names(assembleGuildFull(input(OWNER, []))), ['general', 'staff'])
})

test('@everyone deny hides a channel from a plain member', () => {
  assert.deepEqual(names(assembleGuildFull(input(ALICE, []))), ['general'])
})

test('a role overwrite allow beats the @everyone deny', () => {
  assert.deepEqual(names(assembleGuildFull(input(ALICE, [MOD_ROLE]))), ['general', 'staff'])
})

test('a member overwrite deny beats a role allow', () => {
  const i = input(ALICE, [MOD_ROLE])
  i.overwrites.push(overwrite(STAFF, ALICE, 'member', 0, Permissions.VIEW_CHANNEL))
  assert.deepEqual(names(assembleGuildFull(i)), ['general'])
})

test('a non-member viewer sees no channels', () => {
  assert.deepEqual(names(assembleGuildFull(input('00000000-0000-4000-8000-0000000000ff', []))), [])
})

test('member roles exclude @everyone and overwrites attach to their channel', () => {
  const i = input(ALICE, [MOD_ROLE, GUILD])
  const g = assembleGuildFull(i)
  assert.deepEqual(g.members.find((m) => m.user.id === ALICE)?.roles, [MOD_ROLE])
  assert.equal(g.channels.find((c) => c.id === GENERAL)?.permissionOverwrites.length, 0)
  assert.equal(g.channels.find((c) => c.id === STAFF)?.permissionOverwrites.length, 2)
  assert.equal(g.createdAt, T.toISOString())
})

test('toUser falls back from displayName to name to the email local part', () => {
  assert.equal(toUser({ ...user(ALICE, ''), name: 'Al' }).username, 'Al')
  assert.equal(toUser({ ...user(ALICE, ''), email: 'al@x.io' }).username, 'al')
})

// --- messages query ---------------------------------------------------------
test('messages query defaults to limit 50 and no cursor', () => {
  const q = parseMessageQuery(new URLSearchParams())
  assert.equal(q.limit, 50)
  assert.equal(q.before, undefined)
})

test('messages query accepts limit 100 and a uuid cursor', () => {
  const q = parseMessageQuery(new URLSearchParams({ limit: '100', before: GENERAL }))
  assert.deepEqual(q, { limit: 100, before: GENERAL })
})

test('messages query rejects out-of-range limits and non-uuid cursors', () => {
  assert.throws(() => parseMessageQuery(new URLSearchParams({ limit: '101' })))
  assert.throws(() => parseMessageQuery(new URLSearchParams({ limit: '0' })))
  assert.throws(() => parseMessageQuery(new URLSearchParams({ limit: 'abc' })))
  assert.throws(() => parseMessageQuery(new URLSearchParams({ before: '123' })))
})

// --- report -----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`wire.test: ${failures.length} failed, ${passed} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`wire.test: ${passed} passed`)
