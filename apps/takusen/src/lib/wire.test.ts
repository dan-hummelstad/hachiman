/**
 * Unit tests for the pure wire helpers: GuildFull assembly (per-viewer
 * channel visibility via the shared permission algorithm), the MLS group
 * fields of channels and guilds (§1, §12.6), the ciphertext Message, and the
 * messages query and body parsers. No DB / Redis.
 *
 * Run with `tsx src/lib/wire.test.ts` (part of `pnpm -F @hachiman/takusen test`).
 */
import assert from 'node:assert/strict'

import { DEFAULT_EVERYONE, Permissions } from '@hachiman/client/permissions'

import type { ChannelRow, GuildMemberRow, MessageRow, PermissionOverwriteRow, RoleRow } from '@/db/schema'
import {
  parseCustomStatus,
  assembleGuildFull,
  createMessageSchema,
  DEFAULT_PUBLIC_HISTORY_VISIBILITY,
  editMessageSchema,
  MESSAGE_MAX_UPLOAD_IDS,
  parseMessageQuery,
  toChannel,
  toDmChannel,
  toGuild,
  toInvite,
  toMessage,
  toUser,
  type GuildFullInput,
} from './wire'

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
  return { guildId: GUILD, userId, nick: null, joinedAt: T, inviteId: null, mute: false, deaf: false }
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
    icon: null,
    mlsGroupId: null,
    threadStartMessageId: null,
    createdAt: T,
    lastActivityAt: T,
  }
}
function role(id: string, position: number, permissions: number): RoleRow {
  return { id, guildId: GUILD, name: id === GUILD ? '@everyone' : 'role', color: 0, hoist: false, position, permissions }
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
    guild: { id: GUILD, ownerId: OWNER, name: 'G', icon: null, banner: null, region: null, pageStorageBytes: 0, welcomeChannelId: null, createdAt: T },
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

// --- MLS group fields (§1, §12.6) -------------------------------------------
const GROUP = new Uint8Array(22).fill(7)
const GROUP_B64 = Buffer.from(GROUP).toString('base64url')

test('guild publicHistoryVisibility: the given value, shared by default', () => {
  const g = input(OWNER, []).guild
  assert.equal(toGuild(g, DEFAULT_PUBLIC_HISTORY_VISIBILITY).publicHistoryVisibility, 'shared')
  assert.equal(toGuild(g, 'joined').publicHistoryVisibility, 'joined')
  const i = input(OWNER, [])
  i.publicHistoryVisibility = 'joined'
  assert.equal(assembleGuildFull(i).publicHistoryVisibility, 'joined')
})

test('channel mlsGroupId is base64url and historyVisibility mirrors the group', () => {
  const c = { ...channel(GENERAL, 'general'), mlsGroupId: GROUP }
  const wire = toChannel(c, [], new Map([[GROUP_B64, 'shared' as const]]))
  assert.equal(wire.mlsGroupId, GROUP_B64)
  assert.equal(wire.historyVisibility, 'shared')
  // No group row yet: the default of a channel group.
  assert.equal(toChannel(c, []).historyVisibility, 'joined')
  assert.deepEqual(toChannel(channel(GENERAL, 'general'), []).mlsGroupId, null)
})

// --- threads (§4 Threads, §12.6) -------------------------------------------
const THREAD_STAFF = '00000000-0000-4000-8000-0000000000d1'
const THREAD_GENERAL = '00000000-0000-4000-8000-0000000000d2'
const START = '00000000-0000-4000-8000-0000000000e1'
function thread(id: string, name: string, parentId: string): ChannelRow {
  return { ...channel(id, name), type: 'thread', parentId, ownerId: ALICE, threadStartMessageId: START }
}

test('a thread under a private parent is visible only with the parent', () => {
  const i = input(ALICE, [])
  i.channels = [...i.channels, thread(THREAD_STAFF, 'staff-thread', STAFF), thread(THREAD_GENERAL, 'general-thread', GENERAL)]
  assert.deepEqual(names(assembleGuildFull(i)), ['general', 'general-thread'])
  i.memberRoles = [{ userId: ALICE, roleId: MOD_ROLE }]
  assert.deepEqual(names(assembleGuildFull(i)), ['general', 'staff', 'staff-thread', 'general-thread'])
})

test('a thread has no group fields (readers take the parent), its creator and its start message', () => {
  const wire = toChannel({ ...thread(THREAD_GENERAL, 't', GENERAL), mlsGroupId: GROUP }, [], new Map([[GROUP_B64, 'shared' as const]]))
  assert.equal(wire.mlsGroupId, null)
  assert.equal(wire.historyVisibility, null)
  assert.equal(wire.ownerId, ALICE)
  assert.equal(wire.threadStartMessageId, START)
  assert.deepEqual(wire.permissionOverwrites, [])
  assert.equal('threadStartMessageId' in toChannel(channel(GENERAL, 'general'), []), false)
})

test('voice and category channels have no group fields', () => {
  for (const type of ['voice', 'category'] as const) {
    const wire = toChannel({ ...channel(GENERAL, 'x'), type, mlsGroupId: GROUP }, [], new Map([[GROUP_B64, 'shared' as const]]))
    assert.equal(wire.mlsGroupId, null)
    assert.equal(wire.historyVisibility, null)
  }
})

test('dm channels carry the group fields too', () => {
  const dm: ChannelRow = { ...channel(GENERAL, 'x'), guildId: null, type: 'dm', name: null, mlsGroupId: GROUP }
  const wire = toDmChannel(dm, [user(OWNER, 'owner'), user(ALICE, 'alice')], OWNER, new Map([[GROUP_B64, 'joined' as const]]))
  assert.equal(wire.mlsGroupId, GROUP_B64)
  assert.equal(wire.historyVisibility, 'joined')
  assert.deepEqual(wire.recipients?.map((r) => r.id), [ALICE])
})

// --- ciphertext Message (§1) ------------------------------------------------
test('toMessage: the ciphertext shape, base64url bytes, no content', () => {
  const row: MessageRow = {
    id: '00000000-0000-4000-8000-0000000000d1',
    channelId: GENERAL,
    authorId: ALICE,
    groupId: GROUP,
    epoch: 4,
    senderDevice: '00000000-0000-4000-8000-0000000000e1',
    clientMsgId: new Uint8Array(16).fill(1),
    envelope: new Uint8Array([0x48, 0x01, 2, 3]),
    frankingTag: new Uint8Array(32).fill(9),
    size: 4,
    createdAt: T,
    editedAt: null,
  }
  const att = [{ id: 'f', key: 'f/blob', size: 100 }, { id: 't', key: 't/blob', size: 20 }]
  const m = toMessage(row, user(ALICE, 'alice'), GUILD, att, 'n1')
  assert.deepEqual(m, {
    id: row.id,
    channelId: GENERAL,
    guildId: GUILD,
    author: { id: ALICE, username: 'alice', avatar: null },
    senderDevice: row.senderDevice,
    groupId: GROUP_B64,
    epoch: 4,
    clientMsgId: Buffer.from(row.clientMsgId).toString('base64url'),
    envelope: Buffer.from(row.envelope).toString('base64url'),
    attachments: att,
    createdAt: T.toISOString(),
    editedAt: null,
    nonce: 'n1',
  })
  assert.ok(!('content' in m))
  assert.ok(!('frankingTag' in m))
  assert.equal('nonce' in toMessage(row, user(ALICE, 'alice'), GUILD, []), false)
})

// --- message bodies (§4, §12.8.4) --------------------------------------------
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('message body: the envelope is strict base64url', () => {
  const b = createMessageSchema.parse({ envelope: 'SAE', nonce: 7 })
  assert.deepEqual([...b.envelope], [0x48, 0x01])
  assert.equal(b.nonce, '7')
  assert.deepEqual(b.attachments, [])
  assert.throws(() => createMessageSchema.parse({ envelope: 'SAE=' }))
  assert.throws(() => createMessageSchema.parse({ envelope: 'SA+/' }))
  assert.throws(() => createMessageSchema.parse({ envelope: '' }))
  assert.throws(() => createMessageSchema.parse({ content: 'plaintext' }))
})

test('message body: at most 20 unique upload ids (file, then thumbnail)', () => {
  const ids = Array.from({ length: MESSAGE_MAX_UPLOAD_IDS }, (_, i) => ID(i + 1))
  assert.equal(MESSAGE_MAX_UPLOAD_IDS, 20)
  assert.equal(createMessageSchema.parse({ envelope: 'SAE', attachments: ids }).attachments.length, 20)
  assert.throws(() => createMessageSchema.parse({ envelope: 'SAE', attachments: [...ids, ID(99)] }))
  assert.throws(() => createMessageSchema.parse({ envelope: 'SAE', attachments: [ID(1), ID(1)] }))
  assert.throws(() => createMessageSchema.parse({ envelope: 'SAE', attachments: ['not-a-uuid'] }))
})

test('edit body: only the envelope; attachments cannot change', () => {
  assert.deepEqual([...editMessageSchema.parse({ envelope: 'SAE' }).envelope], [0x48, 0x01])
  assert.throws(() => editMessageSchema.parse({ envelope: 'SAE', attachments: [ID(1)] }))
  assert.throws(() => editMessageSchema.parse({ content: 'x' }))
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

// --- invites ----------------------------------------------------------------
test('toInvite: the id, hasHistory for an invite with a record, and the record stays out', () => {
  const row = { id: ID(9), code: 'ABCD2345', guildId: GUILD, createdBy: OWNER, expiresAt: null, maxUses: 1, uses: 0, revoked: false, record: null, keyId: null, exhaustedAt: null, createdAt: T }
  assert.deepEqual(toInvite(row), {
    id: ID(9),
    code: 'ABCD2345',
    guildId: GUILD,
    createdBy: OWNER,
    expiresAt: null,
    maxUses: 1,
    uses: 0,
    createdAt: T.toISOString(),
    hasHistory: false,
  })
  assert.equal(toInvite({ ...row, record: new Uint8Array([1]), keyId: new Uint8Array(32) }).hasHistory, true)
})

// --- report -----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`wire.test: ${failures.length} failed, ${passed} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`wire.test: ${passed} passed`)

test('parseCustomStatus reads the stored value as the gateway does', () => {
  const now = new Date('2026-10-07T12:00:00Z')
  assert.deepEqual(parseCustomStatus('{"text":"brb","expiresAt":null}', now), { text: 'brb', expiresAt: null })
  assert.deepEqual(parseCustomStatus('{"text":"brb"}', now), { text: 'brb', expiresAt: null })
  assert.deepEqual(parseCustomStatus('{"text":"brb","expiresAt":"2026-10-07T13:00:00Z"}', now), { text: 'brb', expiresAt: '2026-10-07T13:00:00Z' })
  assert.equal(parseCustomStatus('{"text":"brb","expiresAt":"2026-10-07T11:00:00Z"}', now), null)
  assert.equal(parseCustomStatus('{"text":""}', now), null)
  assert.equal(parseCustomStatus('not json', now), null)
  assert.equal(parseCustomStatus(null, now), null)
})
