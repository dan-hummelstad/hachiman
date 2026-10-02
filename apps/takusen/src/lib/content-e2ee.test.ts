/**
 * The content routes on ciphertext (docs/gateway-protocol.md §4, §12.8, §12.16,
 * §12.18): message send and edit through the real envelope checks, the upload
 * claim rules, the membership triggers, the password flows, signed admin
 * actions and franking reports. No DB / Redis: the DS runs on InMemoryMlsRepo,
 * and the message store and the admin chain store are fakes.
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, test } from 'node:test'

import type { Tx } from '@/db/client'
import type { MessageRow, UploadRow } from '@/db/schema'
import {
  applySignedActions,
  matchesRequest,
  parseSignedActions,
  signedRoleCreateId,
  type AdminChainStore,
  type AdminPayload,
  type ChainHead,
} from '@/lib/admin-actions'
import { ApiError, InvalidImageError, MissingPermissionsError, UnknownUploadError, ValidationError } from '@/lib/errors'
import { setBusPublisher } from '@/lib/events'
import { membershipChanged, MembershipTriggers, setMembershipSeam, wakeAfterCommit, type MembershipChange } from '@/lib/guilds'
import { requireDeviceWith } from '@/lib/mls/device-auth'
import { acceptEnvelopeWith } from '@/lib/mls/envelopes'
import { Outbox } from '@/lib/mls/events'
import { postJoinRequest } from '@/lib/mls/joins'
import { uploadKeyPackages } from '@/lib/mls/key-packages'
import { flushWithProposals, onMembershipChangeWith } from '@/lib/mls/membership'
import { activate, activeDevice, fakeKeyPackage, newWorld, runBatchAndCommit, testEnvelope, type World } from '@/lib/mls/testing'
import { completePasswordChange, completePasswordReset, type PasswordResetPorts } from '@/lib/password-reset'
import { claimForMessage, imageClaimError, messageClaimable } from '@/lib/uploads'
import { createMessageSchema } from '@/lib/wire'

import { editMessage, sendMessage, type MessageStore, type NewMessage } from '@/app/api/v1/channels/[id]/messages/service'
import { openReport, reportSchema } from '@/app/api/v1/reports/report'

import { admin } from '../../../../pkgs/hachiman-crypto/src/admin/index'
import type { AdminAction } from '../../../../pkgs/hachiman-crypto/src/api'
import { AdminActionType } from '../../../../pkgs/hachiman-crypto/src/constants'
import { frankingTagSync } from '../../../../pkgs/hachiman-crypto/src/franking/index'
import { identity } from '../../../../pkgs/hachiman-crypto/src/identity/index'
import { ds as realDs } from '../../../../pkgs/hachiman-crypto/src/mls/ds'
import { generateEd25519 } from '../../../../pkgs/hachiman-crypto/src/sign'

setBusPublisher(async () => undefined)

async function rejects(p: Promise<unknown>, code: string, status: number): Promise<ApiError> {
  try {
    await p
  } catch (err) {
    assert.ok(err instanceof ApiError, String(err))
    assert.equal(err.code, code, err.message)
    assert.equal(err.status, status)
    return err
  }
  assert.fail(`expected ${code}`)
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url')

// MARK: - A DM at epoch 1 with two devices per user, and a fake message store

async function dmWorld() {
  const w = await newWorld()
  const alice = w.repo.addUser()
  const bob = w.repo.addUser()
  const a1 = await activeDevice(w, alice)
  const a2 = await activeDevice(w, alice)
  const b1 = await activeDevice(w, bob)
  for (const d of [a2, b1]) await uploadKeyPackages(w.repo, w.deps, d, { cipherSuite: 1, keyPackages: [fakeKeyPackage(d)], lastResort: null })
  const channelId = w.repo.addDm([alice, bob])
  const out = new Outbox()
  await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'dm_created', channelId }, a1.id))
  const group = await activate(w, out, (await w.repo.listGroupsByChannel(channelId))[0]!, a1)
  await runBatchAndCommit(w, group.groupId)
  const leaf = async (deviceId: string) => (await w.repo.memberByDevice(group.groupId, deviceId))!.leafIndex
  return { w, alice, bob, a1, a2, b1, channelId, groupId: group.groupId, leaf, store: new FakeMessageStore(w) }
}

type Dm = Awaited<ReturnType<typeof dmWorld>>

/** The message writes over memory. `claim` applies the real messageClaimable rule. */
class FakeMessageStore implements MessageStore {
  readonly messages = new Map<string, MessageRow>()
  readonly uploads = new Map<string, UploadRow>()
  constructor(private readonly w: World) {}

  blob(uploaderId: string, encrypted = true): string {
    const id = randomUUID()
    this.uploads.set(id, {
      id,
      uploaderId,
      key: encrypted ? `${id}/blob` : `${id}/me.png`,
      filename: encrypted ? null : 'me.png',
      size: 100,
      contentType: encrypted ? 'application/octet-stream' : 'image/png',
      encrypted,
      messageId: null,
      position: 0,
      purpose: null,
      createdAt: new Date(),
    })
    return id
  }

  async insert(v: NewMessage): Promise<MessageRow> {
    for (const m of this.messages.values()) {
      if (m.channelId === v.channelId && b64(m.clientMsgId) === b64(v.clientMsgId)) {
        throw new ApiError('DuplicateMessage', 409, 'the client_msg_id exists in the channel')
      }
    }
    const row: MessageRow = { ...v, id: randomUUID(), createdAt: new Date(this.w.clock.now), editedAt: null }
    this.messages.set(row.id, row)
    // acceptEnvelope reads uniqueness from the DS repo.
    this.w.repo.addMessageClientMsgId(v.channelId, v.clientMsgId)
    return row
  }

  async update(id: string, patch: Partial<MessageRow>): Promise<MessageRow> {
    const row = { ...this.messages.get(id)!, ...patch }
    this.messages.set(id, row)
    return row
  }

  async claim(messageId: string, ids: string[], userId: string): Promise<UploadRow[]> {
    if (ids.some((id) => !this.uploads.has(id) || !messageClaimable(this.uploads.get(id)!, userId))) throw new UnknownUploadError()
    return ids.map((id, position) => {
      const row = { ...this.uploads.get(id)!, messageId, position, purpose: 'attachment' as const }
      this.uploads.set(id, row)
      return row
    })
  }

  async delete(messageId: string): Promise<string[]> {
    const keys: string[] = []
    for (const [id, u] of this.uploads) {
      if (u.messageId === messageId) {
        keys.push(u.key)
        this.uploads.delete(id)
      }
    }
    this.messages.delete(messageId)
    return keys
  }
}

function acceptFor(w: World) {
  return (i: Parameters<typeof acceptEnvelopeWith>[2]) => acceptEnvelopeWith(w.repo, { ds: w.ds, maxEnvelopeBytes: w.config.maxEnvelopeBytes, now: new Date(w.clock.now) }, i)
}

async function envelopeOf(s: Dm, over: Partial<{ device: string; leaf: number; epoch: number; channel: string; groupId: Uint8Array; cmid: Uint8Array }> = {}) {
  return testEnvelope({
    groupId: over.groupId ?? s.groupId,
    channelId: over.channel ?? s.channelId,
    epoch: over.epoch ?? 1,
    senderLeaf: over.leaf ?? (await s.leaf(over.device ?? s.a1.id)),
    senderDeviceId: over.device ?? s.a1.id,
    ...(over.cmid ? { clientMsgId: over.cmid } : {}),
  })
}

async function send(s: Dm, envelope: Uint8Array, opts: { deviceId?: string; userId?: string; attachments?: string[] } = {}) {
  const body = createMessageSchema.parse({ envelope: b64(envelope), attachments: opts.attachments ?? [] })
  return sendMessage(s.store, acceptFor(s.w), { channelId: s.channelId, userId: opts.userId ?? s.alice, deviceId: opts.deviceId ?? s.a1.id, body })
}

// MARK: - Messages

describe('message send through the envelope checks (§12.8.4)', () => {
  test('stores the header fields and the ciphertext, never content', async () => {
    const s = await dmWorld()
    const env = await envelopeOf(s)
    const { row } = await send(s, env)
    assert.deepEqual(row.groupId, s.groupId)
    assert.equal(row.epoch, 1)
    assert.equal(row.senderDevice, s.a1.id)
    assert.deepEqual(row.envelope, env)
    assert.equal(row.size, env.length)
    assert.equal(row.clientMsgId.length, 16)
    assert.equal(row.frankingTag.length, 32)
    assert.ok(!('content' in row))
  })

  test('rejections: size, decode, wrong group, wrong channel', async () => {
    const s = await dmWorld()
    await rejects(send(s, new Uint8Array(s.w.config.maxEnvelopeBytes + 1)), 'EnvelopeTooLarge', 413)
    await rejects(send(s, new Uint8Array([0x48, 0x01, 0xff])), 'InvalidEnvelope', 400)
    await rejects(send(s, await envelopeOf(s, { groupId: new Uint8Array(randomBytes(22)) })), 'InvalidEnvelope', 400)
    await rejects(send(s, await envelopeOf(s, { channel: randomUUID() })), 'InvalidEnvelope', 400)
    assert.equal(s.store.messages.size, 0)
  })

  test('StaleEpoch carries the stored epoch; the grace covers epoch - 1 for 10 s', async () => {
    const s = await dmWorld()
    await send(s, await envelopeOf(s, { epoch: 0 }))
    s.w.clock.now += 10_001
    const err = await rejects(send(s, await envelopeOf(s, { epoch: 0 })), 'StaleEpoch', 409)
    assert.deepEqual(err.extra, { epoch: 1 })
    await rejects(send(s, await envelopeOf(s, { epoch: 2 })), 'StaleEpoch', 409)
  })

  test('NotMember: the header device is not the request device, or the leaf is wrong', async () => {
    const s = await dmWorld()
    await rejects(send(s, await envelopeOf(s, { device: s.a2.id })), 'NotMember', 403)
    await rejects(send(s, await envelopeOf(s, { leaf: 7 })), 'NotMember', 403)
    // Bob's device and leaf, posted by Alice with Bob's device id.
    await rejects(send(s, await envelopeOf(s, { device: s.b1.id }), { deviceId: s.b1.id }), 'NotMember', 403)
  })

  test('DuplicateMessage for a second client_msg_id in the channel', async () => {
    const s = await dmWorld()
    const cmid = new Uint8Array(randomBytes(16))
    await send(s, await envelopeOf(s, { cmid }))
    await rejects(send(s, await envelopeOf(s, { cmid })), 'DuplicateMessage', 409)
  })

  test('a missing or foreign X-Hachiman-Device fails before the envelope', async () => {
    const s = await dmWorld()
    await rejects(requireDeviceWith(s.w.repo, null, s.alice), 'DeviceRequired', 400)
    await rejects(requireDeviceWith(s.w.repo, 'not-a-uuid', s.alice), 'DeviceRequired', 400)
    await rejects(requireDeviceWith(s.w.repo, s.b1.id, s.alice), 'DeviceNotActive', 403)
    assert.equal((await requireDeviceWith(s.w.repo, s.a1.id, s.alice)).id, s.a1.id)
  })
})

describe('message edit (§12.8.6)', () => {
  test('replaces the envelope and the header columns, keeps client_msg_id, sets edited_at', async () => {
    const s = await dmWorld()
    const cmid = new Uint8Array(randomBytes(16))
    const { row } = await send(s, await envelopeOf(s, { cmid }))
    s.w.clock.now += 1000
    // Another device of the author may edit (§12.8.6).
    const env = await envelopeOf(s, { cmid, device: s.a2.id })
    const now = new Date(s.w.clock.now)
    const edited = await editMessage(s.store, acceptFor(s.w), { row, userId: s.alice, deviceId: s.a2.id, envelope: env, now })
    assert.deepEqual(edited.envelope, env)
    assert.equal(edited.senderDevice, s.a2.id)
    assert.equal(edited.size, env.length)
    assert.deepEqual(edited.groupId, s.groupId)
    assert.equal(edited.epoch, 1)
    assert.notDeepEqual(edited.frankingTag, row.frankingTag)
    assert.deepEqual(edited.clientMsgId, cmid)
    assert.equal(edited.authorId, s.alice)
    assert.deepEqual(edited.editedAt, now)
  })

  test('a wrong client_msg_id gives InvalidEnvelope; only the author edits', async () => {
    const s = await dmWorld()
    const { row } = await send(s, await envelopeOf(s))
    await rejects(editMessage(s.store, acceptFor(s.w), { row, userId: s.alice, deviceId: s.a1.id, envelope: await envelopeOf(s), now: new Date() }), 'InvalidEnvelope', 400)
    await assert.rejects(
      editMessage(s.store, acceptFor(s.w), { row, userId: s.bob, deviceId: s.b1.id, envelope: await envelopeOf(s, { device: s.b1.id, cmid: row.clientMsgId }), now: new Date() }),
      MissingPermissionsError,
    )
  })
})

// MARK: - Uploads

describe('upload claims (§4 Files)', () => {
  const me = randomUUID()
  const row = (over: Partial<UploadRow>) => ({ uploaderId: me, purpose: null, encrypted: true, contentType: 'application/octet-stream', ...over }) as UploadRow

  test('a message claims only unclaimed blobs of the caller', () => {
    assert.equal(messageClaimable(row({}), me), true)
    assert.equal(messageClaimable(row({ encrypted: false, contentType: 'image/png' }), me), false)
    assert.equal(messageClaimable(row({ purpose: 'attachment' }), me), false)
    assert.equal(messageClaimable(row({ purpose: 'image' }), me), false)
    assert.equal(messageClaimable(row({}), randomUUID()), false)
  })

  test('an avatar, icon or banner claims only plaintext profile images', () => {
    assert.equal(imageClaimError(row({ encrypted: false, contentType: 'image/png' }), me), null)
    assert.equal(imageClaimError(row({ encrypted: false, contentType: 'image/png', purpose: 'image' }), me), null)
    assert.ok(imageClaimError(row({ encrypted: true }), me) instanceof UnknownUploadError)
    assert.ok(imageClaimError(row({ encrypted: false, contentType: 'image/png', purpose: 'attachment' }), me) instanceof UnknownUploadError)
    assert.ok(imageClaimError(row({ encrypted: false, contentType: 'image/svg+xml' }), me) instanceof InvalidImageError)
    assert.ok(imageClaimError(null, me) instanceof UnknownUploadError)
  })

  test('a message claims at most 20 unique ids', async () => {
    const tx = {} as Tx // the cap is checked before any query
    const ids = Array.from({ length: 21 }, () => randomUUID())
    await assert.rejects(claimForMessage(tx, randomUUID(), ids, me), ValidationError)
    await assert.rejects(claimForMessage(tx, randomUUID(), [ids[0]!, ids[0]!], me), ValidationError)
    assert.deepEqual(await claimForMessage(tx, randomUUID(), [], me), [])
  })

  test('a message with a file and its thumbnail claims both; a delete removes both blobs', async () => {
    const s = await dmWorld()
    const file = s.store.blob(s.alice)
    const thumb = s.store.blob(s.alice)
    const { row, claimed } = await send(s, await envelopeOf(s), { attachments: [file, thumb] })
    assert.deepEqual(claimed.map((u) => [u.id, u.position]), [[file, 0], [thumb, 1]])
    assert.deepEqual((await s.store.delete(row.id)).sort(), [`${file}/blob`, `${thumb}/blob`].sort())
    assert.equal(s.store.messages.size, 0)
  })

  test('a profile image cannot be a message attachment', async () => {
    const s = await dmWorld()
    const image = s.store.blob(s.alice, false)
    await assert.rejects(send(s, await envelopeOf(s), { attachments: [image] }), UnknownUploadError)
  })
})

// MARK: - Membership triggers

describe('membership triggers (§12.18)', () => {
  afterEach(() => setMembershipSeam(null))

  test('each trigger gives its change, and membershipChanged passes it with the actor', async () => {
    const calls: { tx: unknown; change: MembershipChange; actor: string | null }[] = []
    const woken: unknown[] = []
    setMembershipSeam({
      async change(tx, change, actor) {
        calls.push({ tx, change, actor })
      },
      async wake(tx) {
        woken.push(tx)
      },
    })
    const tx = { id: 'tx' } as unknown as Tx
    const [g, u, c, r] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    const expected: [MembershipChange, MembershipChange][] = [
      [MembershipTriggers.guildCreated(g), { kind: 'guild_created', guildId: g }],
      [MembershipTriggers.guildDeleted(g), { kind: 'guild_deleted', guildId: g }],
      [MembershipTriggers.memberJoined(g, u), { kind: 'guild_member_added', guildId: g, userId: u }],
      [MembershipTriggers.memberLeft(g, u), { kind: 'guild_member_removed', guildId: g, userId: u }],
      [MembershipTriggers.memberRolesEdited(g, u), { kind: 'member_roles_changed', guildId: g, userId: u }],
      [MembershipTriggers.roleChanged(g, r), { kind: 'role_changed', guildId: g, roleId: r }],
      [MembershipTriggers.roleDeleted(g, r), { kind: 'role_deleted', guildId: g, roleId: r }],
      [MembershipTriggers.overwritesChanged(c), { kind: 'overwrites_changed', channelId: c }],
      [MembershipTriggers.channelCreated(c), { kind: 'channel_created', channelId: c }],
      [MembershipTriggers.channelDeleted(g, c), { kind: 'channel_deleted', guildId: g, channelId: c }],
      [MembershipTriggers.dmCreated(c), { kind: 'dm_created', channelId: c }],
      [MembershipTriggers.userDeleted(u), { kind: 'user_deleted', userId: u }],
      [MembershipTriggers.passwordReset(u), { kind: 'devices_revoked', userId: u, deviceIds: 'all', reason: 'password_reset' }],
    ]
    for (const [got, want] of expected) assert.deepEqual(got, want)
    await membershipChanged(tx, expected.map(([c]) => c), 'dev-1')
    assert.deepEqual(calls.map((x) => x.change), expected.map(([, w]) => w))
    assert.ok(calls.every((x) => x.tx === tx && x.actor === 'dev-1'))

    await wakeAfterCommit(tx)
    await wakeAfterCommit(undefined)
    assert.deepEqual(woken, [tx])
  })

  test('a wake failure is logged, not thrown: the write has committed', async () => {
    setMembershipSeam({ change: async () => {}, wake: async () => Promise.reject(new Error('redis down')) })
    const error = console.error
    console.error = () => {}
    try {
      await wakeAfterCommit({} as Tx)
    } finally {
      console.error = error
    }
  })

  test('the triggers are changes that the DS accepts: a kick queues the Removes of the user', async () => {
    const w = await newWorld()
    const owner = w.repo.addUser()
    const alice = w.repo.addUser()
    const guildId = w.repo.addGuild(owner, undefined, 1 << 10)
    w.repo.addChannel({ guildId, type: 'text' })
    w.repo.addGuildMember(guildId, alice)
    const o1 = await activeDevice(w, owner)
    const a1 = await activeDevice(w, alice)
    const out = new Outbox()
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, MembershipTriggers.guildCreated(guildId), o1.id))
    const set = await activate(w, out, (await w.repo.listGroupsByGuild(guildId)).find((g) => g.kind === 'public_set')!, o1)
    // Alice joins the public_set group: a join request, then the owner commits the DS Add.
    const joinOut = new Outbox()
    await postJoinRequest(w.repo, w.deps, joinOut, { userId: alice, device: a1 }, set.groupId, fakeKeyPackage(a1))
    await flushWithProposals(w.repo, joinOut, w.deps)
    await runBatchAndCommit(w, set.groupId)
    const leaf = (await w.repo.memberByDevice(set.groupId, a1.id))!.leafIndex

    w.repo.removeGuildMember(guildId, alice)
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, new Outbox(), MembershipTriggers.memberLeft(guildId, alice), o1.id))
    const removes = (await w.repo.listPending(set.groupId, ['queued', 'assigned'])).filter((p) => p.op === 'remove')
    assert.deepEqual(removes.map((p) => p.leafIndex), [leaf])
  })
})

// MARK: - Password flows

describe('password reset and change (§12.4, §12.18)', () => {
  afterEach(() => setMembershipSeam(null))

  function resetPorts(w: World, out: Outbox, tokens: Map<string, string>) {
    const log: string[] = []
    const ports: PasswordResetPorts<string> = {
      transaction: (fn) => fn('tx'),
      async consumeToken(_tx, hash) {
        const userId = tokens.get(hash) ?? null
        tokens.delete(hash)
        return userId
      },
      async setPassword(_tx, userId) {
        log.push(`password:${userId}`)
      },
      membership: (_tx, change) => w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, change, null)),
      async afterCommit(tx) {
        log.push(`wake:${tx}`)
      },
      async revokeSessions(userId) {
        log.push(`sessions:${userId}`)
      },
    }
    return { ports, log }
  }

  test('a reset revokes every device and session and supersedes the master key', async () => {
    const w = await newWorld()
    const alice = w.repo.addUser()
    const d1 = await activeDevice(w, alice)
    const d2 = await activeDevice(w, alice)
    const out = new Outbox()
    const { ports, log } = resetPorts(w, out, new Map([['h1', alice]]))

    assert.equal(await completePasswordReset(ports, { tokenHash: 'h1', passwordHash: 'x', now: new Date() }), alice)
    for (const d of [d1, d2]) {
      assert.equal((await w.repo.getDevice(d.id))!.status, 'revoked')
      assert.equal((await w.repo.listRevocations(alice)).find((r) => r.deviceId === d.id)?.reason, 'password_reset')
    }
    assert.ok((await w.repo.listMasterKeys(alice))[0]!.supersededAt, 'no current master key after a reset')
    assert.deepEqual(log, [`password:${alice}`, 'wake:tx', `sessions:${alice}`])
    assert.equal(out.events.filter((e) => e.t === 'DEVICE_REVOKED').length, 2)

    // The token is single use.
    const again = resetPorts(w, new Outbox(), new Map())
    assert.equal(await completePasswordReset(again.ports, { tokenHash: 'h1', passwordHash: 'y', now: new Date() }), null)
    assert.deepEqual(again.log, [])
  })

  test('a password change revokes the sessions, keeps this browser and the devices', async () => {
    const calls: string[] = []
    setMembershipSeam({
      async change(_tx, change) {
        calls.push(`ds:${change.kind}`)
      },
      async wake() {
        calls.push('ds:wake')
      },
    })
    await completePasswordChange(
      {
        setPassword: async (u) => void calls.push(`password:${u}`),
        revokeSessions: async (u) => void calls.push(`sessions:${u}`),
        keepCurrentSession: async () => void calls.push('reissue'),
      },
      { userId: 'u1', passwordHash: 'h' },
    )
    assert.deepEqual(calls, ['password:u1', 'sessions:u1', 'reissue'])
  })
})

// MARK: - Signed admin actions

class MemoryChain implements AdminChainStore {
  readonly rows: { guildId: string; seq: number; action: Uint8Array; hash: Uint8Array; actorUserId: string }[] = []
  async lockHead(guildId: string): Promise<ChainHead | null> {
    const last = this.rows.filter((r) => r.guildId === guildId).at(-1)
    return last ? { seq: last.seq, hash: last.hash } : null
  }
  async append(row: MemoryChain['rows'][number]): Promise<void> {
    this.rows.push(row)
  }
}

function actorOf(userId: string) {
  const keys = generateEd25519()
  const deviceId = randomUUID()
  const certificate = identity.encodeDeviceCertificate({
    userId,
    deviceId,
    mlsSignatureKey: keys.publicKey,
    hpkeKey: new Uint8Array(32),
    dskGeneration: 1,
    issuedAtMs: 1,
    displayName: 'd',
    signature: new Uint8Array(64),
  })
  return { userId, deviceId, certificate, privateKey: keys.privateKey }
}

type Actor = ReturnType<typeof actorOf>

function signAction(actor: Actor, guildId: string, seq: number, prev: AdminAction | null, p: AdminPayload, over: Partial<AdminAction> = {}): { bytes: Uint8Array; action: AdminAction } {
  const action = admin.sign(
    {
      guildId,
      seq,
      type: p.type,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      timestampMs: 1_700_000_000_000 + seq,
      prevHash: prev ? admin.hash(prev) : new Uint8Array(32),
      payload: admin.encodePayload(p),
      ...over,
    },
    actor.privateKey,
  )
  return { bytes: admin.encodeAction(action), action }
}

describe('signed admin actions (§12.16)', () => {
  const guildId = randomUUID()
  const ownerId = randomUUID()
  const roleId = randomUUID()
  const genesis: AdminPayload = { type: AdminActionType.GENESIS, ownerId }
  const create: AdminPayload = { type: AdminActionType.ROLE_CREATE, roleId, permissions: 1 << 10, position: 1 }

  function run(store: MemoryChain, actor: Actor, actions: Uint8Array[], expected: AdminPayload | 'genesis') {
    return applySignedActions(store, realDs, { guildId, ownerId, actor, actions, expected })
  }

  test('optional before the genesis, required after it', async () => {
    const store = new MemoryChain()
    const owner = actorOf(ownerId)
    assert.deepEqual(await run(store, owner, [], create), [])
    const g = signAction(owner, guildId, 0, null, genesis)
    await run(store, owner, [g.bytes], 'genesis')
    assert.equal(store.rows.length, 1)
    await rejects(run(store, owner, [], create), 'InvalidAdminAction', 400)
  })

  test('the genesis and the first action in one header continue the chain', async () => {
    const store = new MemoryChain()
    const owner = actorOf(ownerId)
    const g = signAction(owner, guildId, 0, null, genesis)
    const c = signAction(owner, guildId, 1, g.action, create)
    const stored = await run(store, owner, [g.bytes, c.bytes], create)
    assert.deepEqual(stored.map((a) => a.seq), [0, 1])
    assert.deepEqual(store.rows.map((r) => r.seq), [0, 1])
    assert.deepEqual(store.rows[1]!.hash, admin.hash(c.action))
    assert.equal(signedRoleCreateId(`${b64(g.bytes)},${b64(c.bytes)}`), roleId)

    // seq 2 continues from the role create.
    const u = signAction(owner, guildId, 2, c.action, { type: AdminActionType.ROLE_DELETE, roleId })
    await run(store, owner, [u.bytes], { type: AdminActionType.ROLE_DELETE, roleId })
    assert.equal(store.rows.length, 3)
  })

  test('a replayed seq or a wrong prev_hash gives AdminActionConflict', async () => {
    const store = new MemoryChain()
    const owner = actorOf(ownerId)
    const g = signAction(owner, guildId, 0, null, genesis)
    const c = signAction(owner, guildId, 1, g.action, create)
    await run(store, owner, [g.bytes, c.bytes], create)
    await rejects(run(store, owner, [c.bytes], create), 'AdminActionConflict', 409)
    const forked = signAction(owner, guildId, 2, g.action, { type: AdminActionType.ROLE_DELETE, roleId })
    await rejects(run(store, owner, [forked.bytes], { type: AdminActionType.ROLE_DELETE, roleId }), 'AdminActionConflict', 409)
    // The chain starts with the genesis.
    await rejects(run(new MemoryChain(), owner, [signAction(owner, guildId, 0, null, create).bytes], create), 'AdminActionConflict', 409)
    assert.equal(store.rows.length, 2)
  })

  test('a bad signature, another actor device, a mismatch or a non-owner genesis gives InvalidAdminAction', async () => {
    const owner = actorOf(ownerId)
    const g = signAction(owner, guildId, 0, null, genesis)

    const tampered = g.bytes.slice()
    tampered[tampered.length - 1]! ^= 1
    await rejects(run(new MemoryChain(), owner, [tampered], 'genesis'), 'InvalidAdminAction', 400)

    // Signed by the owner, presented with the certificate of another device.
    const other = { ...actorOf(ownerId), userId: ownerId }
    await rejects(run(new MemoryChain(), other, [g.bytes], 'genesis'), 'InvalidAdminAction', 400)

    const store = new MemoryChain()
    await run(store, owner, [g.bytes], 'genesis')
    const c = signAction(owner, guildId, 1, g.action, create)
    await rejects(run(store, owner, [c.bytes], { ...create, permissions: 1 << 11 }), 'InvalidAdminAction', 400)
    await rejects(run(store, owner, [c.bytes], { type: AdminActionType.ROLE_DELETE, roleId }), 'InvalidAdminAction', 400)
    // A genesis alone does not sign the change of the request.
    await rejects(run(new MemoryChain(), owner, [g.bytes], create), 'InvalidAdminAction', 400)

    const mallory = actorOf(randomUUID())
    const fake = signAction(mallory, guildId, 0, null, { type: AdminActionType.GENESIS, ownerId: mallory.userId })
    await rejects(run(new MemoryChain(), mallory, [fake.bytes], 'genesis'), 'InvalidAdminAction', 400)
    const wrongGuild = signAction(owner, randomUUID(), 0, null, genesis)
    await rejects(run(new MemoryChain(), owner, [wrongGuild.bytes], 'genesis'), 'InvalidAdminAction', 400)
  })

  test('reorders and member roles match as sets', () => {
    const [r1, r2, u] = [randomUUID(), randomUUID(), randomUUID()]
    assert.ok(
      matchesRequest(
        { type: 4, positions: [{ roleId: r1, position: 1 }, { roleId: r2, position: 2 }] },
        { type: 4, positions: [{ roleId: r2, position: 2 }, { roleId: r1, position: 1 }] },
      ),
    )
    assert.ok(!matchesRequest({ type: 4, positions: [{ roleId: r1, position: 1 }] }, { type: 4, positions: [{ roleId: r1, position: 2 }] }))
    assert.ok(matchesRequest({ type: 7, userId: u, roleIds: [r1, r2] }, { type: 7, userId: u, roleIds: [r2, r1] }))
    assert.ok(!matchesRequest({ type: 7, userId: u, roleIds: [r1] }, { type: 7, userId: u, roleIds: [r1, r2] }))
    assert.ok(
      matchesRequest(
        { type: 5, channelId: r1, targetId: u, targetType: 'member', allow: 1, deny: 2 },
        { type: 5, channelId: r1, targetId: u, targetType: 'member', allow: 1, deny: 2 },
      ),
    )
    assert.ok(!matchesRequest({ type: 8, channelId: r1, historyVisibility: 'joined' }, { type: 8, channelId: r1, historyVisibility: 'shared' }))
  })

  test('the header: at most two base64url actions', () => {
    assert.deepEqual(parseSignedActions(null), [])
    assert.deepEqual(parseSignedActions('  '), [])
    assert.equal(parseSignedActions('AQ, Ag').length, 2)
    assert.throws(() => parseSignedActions('AQ,AQ,AQ'), (e: unknown) => e instanceof ApiError && e.code === 'InvalidAdminAction')
    assert.throws(() => parseSignedActions('AQ=='), (e: unknown) => e instanceof ApiError && e.code === 'InvalidAdminAction')
    assert.equal(signedRoleCreateId(null), null)
    assert.equal(signedRoleCreateId('AQ'), null)
  })
})

// MARK: - Franking reports

describe('franking reports (§12.16)', () => {
  const channelId = randomUUID()
  const clientMsgId = new Uint8Array(randomBytes(16))
  const frankingKey = new Uint8Array(randomBytes(32))
  const content = new Uint8Array(randomBytes(120))
  const message = { id: randomUUID(), channelId, clientMsgId, frankingTag: frankingTagSync({ frankingKey, channelId, clientMsgId, content }) }
  const body = (over: Partial<{ content: Uint8Array; frankingKey: Uint8Array }> = {}) =>
    reportSchema.parse({ messageId: message.id, content: b64(over.content ?? content), frankingKey: b64(over.frankingKey ?? frankingKey), reason: 'spam' })

  test('the opening verifies against the stored tag', () => {
    const r = openReport(realDs, message, 'reporter', body())
    assert.equal(r.verified, true)
    assert.deepEqual(r.content, content)
    assert.equal(r.channelId, channelId)
  })

  test('other content, another key or another message does not verify, and is still stored', () => {
    const flipped = content.slice()
    flipped[0]! ^= 1
    assert.equal(openReport(realDs, message, 'r', body({ content: flipped })).verified, false)
    assert.equal(openReport(realDs, message, 'r', body({ frankingKey: new Uint8Array(randomBytes(32)) })).verified, false)
    assert.equal(openReport(realDs, { ...message, clientMsgId: new Uint8Array(randomBytes(16)) }, 'r', body()).verified, false)
    assert.equal(openReport(realDs, { ...message, channelId: randomUUID() }, 'r', body()).verified, false)
  })

  test('the body: a 32-byte key, content at most an envelope, a reason', () => {
    assert.throws(() => reportSchema.parse({ messageId: message.id, content: b64(content), frankingKey: b64(new Uint8Array(33)), reason: 'x' }))
    assert.throws(() => reportSchema.parse({ messageId: message.id, content: b64(content), frankingKey: b64(frankingKey), reason: '' }))
    assert.throws(() => reportSchema.parse({ messageId: 'x', content: b64(content), frankingKey: b64(frankingKey), reason: 'x' }))
  })
})
