import { describe, expect, it } from 'vitest'

import type { CryptoEvents, EncryptedMessage, InvitePort } from '../api'
import { admin } from '../admin/index'
import { createAdminService } from '../admin/service'
import { fromB64url, toB64url } from '../codec'
import { DsError, testPermissions } from '../identity/test-helpers'
import { FakeMlsDs, leafGeneration, type Client } from './fake-ds'
import { mls } from './index'
import { createGroupService } from './service'
import { keyPackage, makeDevice, makeUser } from './test-helpers'

async function world(names: string[]): Promise<{ ds: FakeMlsDs; c: Record<string, Client> }> {
  const ds = await new FakeMlsDs().init()
  const c: Record<string, Client> = {}
  for (const n of names) c[n] = await ds.client(ds.uuid())
  await ds.flush()
  return { ds, c }
}

/** An InvitePort that records the hooks and gives no invite join. */
function testPort(hooks: Partial<Pick<InvitePort, 'ownCommit' | 'joined'>>): InvitePort {
  return { authFor: () => Promise.resolve(null), checkJoin: () => Promise.resolve('test'), ownCommit: () => undefined, joined: () => undefined, ...hooks }
}

async function epochOf(c: Client, gid: string): Promise<number | null> {
  return c.groups.currentEpoch(fromB64url(gid))
}

async function secretOf(c: Client, gid: string): Promise<string | null> {
  const e = await epochOf(c, gid)
  if (e === null) return null
  const s = await c.groups.epochSecret(fromB64url(gid), e)
  return s === null ? null : toB64url(s)
}

/** A channel group with every client as a reader, created by the first one and committed with its Adds. */
async function channelGroup(ds: FakeMlsDs, members: Client[], historyVisibility: 'joined' | 'shared' = 'joined') {
  const guildId = ds.guild(members.map((m) => m.userId))
  const channelId = ds.channel(guildId, members.map((m) => m.userId))
  const gid = ds.allocate('channel', { guildId, channelId }, members[0]!.deviceId, historyVisibility)
  await ds.flush()
  ds.batch(gid, members[0]!.deviceId)
  await ds.flush()
  return { guildId, channelId, gid }
}

describe('GroupService', () => {
  it('creates a group, adds members by batch, removes before send, and resyncs', async () => {
    const { ds, c } = await world(['alice', 'bob', 'carol'])
    const { alice, bob, carol } = c as Record<'alice' | 'bob' | 'carol', Client>
    const { channelId, gid } = await channelGroup(ds, [alice, bob, carol])
    expect(await epochOf(alice, gid)).toBe(1)
    expect(await epochOf(bob, gid)).toBe(1)
    expect(await secretOf(bob, gid)).toBe(await secretOf(alice, gid))
    expect(await secretOf(carol, gid)).toBe(await secretOf(alice, gid))
    expect(await bob.groups.getEpochCode(gid)).toBe(await alice.groups.getEpochCode(gid))
    const timeline = await alice.groups.membershipTimeline(channelId, 10)
    expect(timeline.map((e) => e.kind)).toEqual(['created', 'added'])

    // carol loses VIEW_CHANNEL: the DS queues a Remove and publishes the proposal.
    ds.channels.get(channelId)!.readers.delete(carol.userId)
    await ds.queueRemove(gid, carol.deviceId)
    await ds.flush()
    expect(await epochOf(alice, gid)).toBe(1)
    const send = await alice.groups.sendState(channelId)
    expect(send.epoch).toBe(2)
    await ds.flush()
    expect(await epochOf(bob, gid)).toBe(2)
    expect(await epochOf(carol, gid)).toBeNull()
    expect(await secretOf(bob, gid)).toBe(toB64url(send.epochSecret))
    expect((await bob.groups.membershipTimeline(channelId, 10)).at(-1)).toMatchObject({ kind: 'removed', actorUserId: alice.userId, subjects: [{ userId: carol.userId, deviceId: carol.deviceId }] })

    // A resync of bob's leaf (fork): alice processes the external commit.
    await bob.groups.resyncAll('fork')
    await ds.flush()
    expect(await epochOf(alice, gid)).toBe(3)
    expect(await secretOf(alice, gid)).toBe(await secretOf(bob, gid))
    expect(ds.log.filter((l) => l.startsWith('Invalid') || l.startsWith('Illegal'))).toEqual([])
  }, 120_000)

  it('lets exactly one of two concurrent commits win; the loser catches up and retries', async () => {
    const { ds, c } = await world(['alice', 'bob', 'carol'])
    const { alice, bob, carol } = c as Record<'alice' | 'bob' | 'carol', Client>
    const { channelId, gid } = await channelGroup(ds, [alice, bob, carol])
    ds.channels.get(channelId)!.readers.delete(carol.userId)
    await ds.queueRemove(gid, carol.deviceId)
    await ds.flush()
    // Both hold the stored Remove, so both must commit before they send.
    const [a, b] = await Promise.all([alice.groups.sendState(channelId), bob.groups.sendState(channelId)])
    expect(a.epoch).toBe(2)
    expect(b.epoch).toBe(2)
    expect(toB64url(a.epochSecret)).toBe(toB64url(b.epochSecret))
    expect(ds.groups.get(gid)!.handshakes.filter((h) => h.kind === 'commit')).toHaveLength(2)
    await ds.flush()
    expect(await epochOf(alice, gid)).toBe(2)
    expect(await epochOf(bob, gid)).toBe(2)
  }, 120_000)

  it('commits DS Add proposals in public_set; every member processes the commit', async () => {
    const { ds, c } = await world(['alice', 'bob', 'carol'])
    const { alice, bob, carol } = c as Record<'alice' | 'bob' | 'carol', Client>
    const guildId = ds.guild([alice.userId, bob.userId, carol.userId])
    const general = ds.channel(guildId, [alice.userId, bob.userId, carol.userId])
    const gid = ds.allocate('public_set', { guildId, channelId: null }, alice.deviceId)
    await ds.flush()
    // A public_set group gets no Adds at create time: devices join on first open.
    expect((await bob.groups.ensureChannelGroup(general)).member).toBe(false)
    await ds.flush()
    expect(ds.groups.get(gid)!.handshakes.map((h) => h.kind)).toEqual(['proposal'])
    ds.batch(gid, alice.deviceId)
    await ds.flush()
    expect(await epochOf(bob, gid)).toBe(1)
    // carol joins; bob commits; alice is a member that did not commit.
    await carol.groups.ensureChannelGroup(general)
    await ds.flush()
    ds.batch(gid, bob.deviceId)
    await ds.flush()
    for (const x of [alice, bob, carol]) expect(await epochOf(x, gid)).toBe(2)
    expect(await secretOf(alice, gid)).toBe(await secretOf(carol, gid))
    expect(ds.log.filter((l) => l.startsWith('Invalid') || l.startsWith('Illegal'))).toEqual([])
  }, 120_000)

  it('refuses to send while a Remove is pending, and commits it first', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    const { channelId, gid } = await channelGroup(ds, [alice, bob])
    ds.channels.get(channelId)!.readers.delete(bob.userId)
    await ds.queueRemove(gid, bob.deviceId)
    await ds.flush()
    ds.onCommit = () => {
      throw new DsError('RateLimited')
    }
    await expect(alice.groups.sendState(channelId)).rejects.toThrow()
    expect(ds.groups.get(gid)!.epoch).toBe(1)
    ds.onCommit = null
    const s = await alice.groups.sendState(channelId)
    expect(s.epoch).toBe(2)
    expect(mls.roster(await mls.restore((await alice.store.get('groups', gid))!.state)).map((r) => r.deviceId)).toEqual([alice.deviceId])
  }, 120_000)

  it('joins by external commit when the DS has no online member', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    const guildId = ds.guild([alice.userId, bob.userId])
    const general = ds.channel(guildId, [alice.userId, bob.userId])
    const gid = ds.allocate('public_set', { guildId, channelId: null }, alice.deviceId)
    await ds.flush()
    alice.online = false
    const joins: number[] = []
    bob.groups.attachInvites(testPort({ joined: (e) => joins.push(e.epoch) }))
    await bob.groups.ensureChannelGroup(general)
    const req = [...ds.joinRequests.values()].find((r) => r.deviceId === bob.deviceId)!
    ds.groups.get(gid)!.pending = []
    ds.joinUpdate(req.id, 'external_commit')
    await ds.flush()
    expect(await epochOf(bob, gid)).toBe(1)
    expect(joins).toEqual([1])
    alice.online = true
    await alice.groups.sync()
    expect(await secretOf(alice, gid)).toBe(await secretOf(bob, gid))
    expect((await alice.groups.membershipTimeline(general, 10)).at(-1)).toMatchObject({ kind: 'joined_external', actorUserId: null })
  }, 120_000)

  it('backs up the history keys on sync, so a restore from the recovery key reads old epochs', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    const { gid } = await channelGroup(ds, [alice, bob])
    const epoch = (await epochOf(alice, gid))!
    await alice.groups.sync()
    const restored = await ds.client(alice.userId, { recoveryKey: (alice as Client & { recoveryKey: string }).recoveryKey })
    const secret = await restored.groups.epochSecret(fromB64url(gid), epoch)
    expect(secret && toB64url(secret)).toBe(await secretOf(alice, gid))
  }, 120_000)

  it('joins a new own device to channel and dm groups through sync join requests', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    const { gid } = await channelGroup(ds, [alice, bob])
    const dmChannel = ds.channel(null, [alice.userId, bob.userId])
    const dm = ds.allocate('dm', { guildId: null, channelId: dmChannel }, bob.deviceId)
    await ds.flush()
    ds.batch(dm, bob.deviceId)
    await ds.flush()
    expect(await epochOf(alice, dm)).toBe(1)
    const alice2 = await ds.client(alice.userId, { recoveryKey: (alice as Client & { recoveryKey: string }).recoveryKey })
    await ds.flush()
    await alice2.groups.sync()
    await ds.flush()
    for (const g of [gid, dm]) {
      expect(await epochOf(alice2, g)).toBe(2)
      expect(await secretOf(alice2, g)).toBe(await secretOf(bob, g))
      expect(await secretOf(alice, g)).toBe(await secretOf(bob, g))
    }
  }, 120_000)

  it('resyncs every own leaf after a DSK rotation', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    const rk = (alice as Client & { recoveryKey: string }).recoveryKey
    const alice2 = await ds.client(alice.userId, { recoveryKey: rk })
    const alice3 = await ds.client(alice.userId, { recoveryKey: rk })
    await ds.flush()
    const { gid } = await channelGroup(ds, [alice, alice2, alice3, bob])
    const roster0 = mls.roster(await mls.restore((await bob.store.get('groups', gid))!.state))
    expect(leafGeneration(roster0, alice2.deviceId)).toBe(1)
    await alice.identity.revokeDevice(alice3.deviceId, 'lost')
    alice3.online = false
    await ds.queueRemove(gid, alice3.deviceId)
    await ds.flush()
    await bob.groups.sync()
    await ds.flush()
    const roster = mls.roster(await mls.restore((await bob.store.get('groups', gid))!.state))
    expect(leafGeneration(roster, alice.deviceId)).toBe(2)
    expect(leafGeneration(roster, alice2.deviceId)).toBe(2)
    // The revoked device keeps its leaf until a member commits the queued Remove before it sends.
    expect(leafGeneration(roster, alice3.deviceId)).toBe(1)
    await bob.groups.sendState(ds.groups.get(gid)!.channelId!)
    await ds.flush()
    expect(leafGeneration(mls.roster(await mls.restore((await bob.store.get('groups', gid))!.state)), alice3.deviceId)).toBeNull()
    for (const x of [alice, alice2]) expect(await secretOf(x, gid)).toBe(await secretOf(bob, gid))
    expect(alice.of('error')).toEqual([])
    expect(ds.log.filter((l) => l.startsWith('Invalid') || l.startsWith('Illegal'))).toEqual([])
  }, 120_000)

  it('recovers an own commit after a crash between the POST and the store write', async () => {
    const { ds, c } = await world(['alice', 'bob', 'carol'])
    const { alice, bob, carol } = c as Record<'alice' | 'bob' | 'carol', Client>
    const { channelId, gid } = await channelGroup(ds, [alice, bob, carol])
    ds.channels.get(channelId)!.readers.delete(carol.userId)
    await ds.queueRemove(gid, carol.deviceId)
    await ds.flush()
    // The DS stores the commit, but the response never reaches alice.
    const post = alice.transport.postCommit.bind(alice.transport)
    alice.transport.postCommit = async (g, body) => {
      await post(g, body)
      throw new DsError('Timeout')
    }
    await expect(alice.groups.sendState(channelId)).rejects.toThrow()
    expect(await alice.store.get('pendingCommits', gid)).toBeDefined()
    alice.transport.postCommit = post
    // A restart: a new service on the same store adopts the stored state from the stream.
    const restarted = await ds.client(alice.userId, { store: alice.store })
    await restarted.groups.sync()
    await ds.flush()
    expect(await epochOf(restarted, gid)).toBe(2)
    expect(await secretOf(restarted, gid)).toBe(await secretOf(bob, gid))
    expect(await restarted.store.get('pendingCommits', gid)).toBeUndefined()
    // bob processed the Remove of carol: epoch 2 is the first epoch without her leaf.
    expect(await bob.groups.removedAt(fromB64url(gid), carol.deviceId)).toBe(2)
    expect(await bob.groups.removedAt(fromB64url(gid), alice.deviceId)).toBeNull()
  }, 120_000)

  it('rejects batch joins with a bad chain or of a non-reader', async () => {
    const { ds, c } = await world(['alice', 'bob', 'dave'])
    const { alice, bob, dave } = c as Record<'alice' | 'bob' | 'dave', Client>
    const { gid } = await channelGroup(ds, [alice, bob])
    // dave is no reader, but the DS queues his Add anyway.
    await ds.queueAdd(gid, dave.deviceId)
    // A key package with a chain from a master key that the DS never had.
    const rogue = makeDevice(makeUser())
    await ds.queueAdd(gid, rogue.deviceId, (await keyPackage(rogue)).publicPackage, null, rogue.user.userId)
    ds.batch(gid, alice.deviceId)
    await ds.flush()
    expect(ds.log.filter((l) => l.startsWith('rejected')).sort()).toEqual(['rejected invalid_chain', 'rejected not_reader'])
    expect(await epochOf(dave, gid)).toBeNull()
    expect(await epochOf(bob, gid)).toBe(2)
  }, 120_000)

  it('fails closed without a verified genesis action: no Adds into a channel group (admin_chain_missing)', async () => {
    const ds = await new FakeMlsDs().init()
    const alice = await ds.client(ds.uuid(), { adminPermissions: true })
    const bob = await ds.client(ds.uuid())
    await ds.flush()
    // The DS returns an empty admin chain: alice has no cached admin state and no genesis.
    const { guildId, gid } = await channelGroup(ds, [alice, bob])
    expect(ds.log.filter((l) => l.startsWith('rejected'))).toEqual(['rejected policy'])
    expect(alice.of<CryptoEvents['error']>('error').map((e) => e.message).join()).toContain('admin_chain_missing')
    expect(await epochOf(bob, gid)).toBeNull()
    // With the owner genesis, the replayed chain decides (testPermissions: only the owner reads).
    const g = await createAdminService(alice.ctx, alice.identity, testPermissions).signAdminAction(guildId, 0, admin.encodePayload({ type: 0, ownerId: alice.userId }))
    ds.id.storeAdminAction(guildId, g.header)
    await ds.queueAdd(gid, bob.deviceId)
    ds.batch(gid, alice.deviceId)
    await ds.flush()
    const later = ds.log.filter((l) => l.startsWith('rejected')).slice(1)
    expect(later).toContain('rejected not_reader')
    expect(later).not.toContain('rejected policy')
  }, 120_000)

  it('shares history in a shared group: the joiner reads old epochs with membershipVerified false', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    const guildId = ds.guild([alice.userId, bob.userId])
    const channelId = ds.channel(guildId, [alice.userId, bob.userId])
    const gid = ds.allocate('channel', { guildId, channelId }, alice.deviceId, 'shared')
    await ds.flush()
    ds.groups.get(gid)!.pending = []
    // An epoch-0 message: only alice is a member.
    const old = await alice.messages.encryptMessage({ channelId, kind: 'message', editOf: null, content: { text: 'before you came', mentions: [], attachments: [], replyTo: null, linkPreview: null } })
    await ds.queueAdd(gid, bob.deviceId)
    ds.batch(gid, alice.deviceId)
    await ds.flush()
    expect(ds.groups.get(gid)!.bundles.map((b) => b.epoch)).toEqual([1])
    const now = await alice.messages.encryptMessage({ channelId, kind: 'message', editOf: null, content: { text: 'hello', mentions: [], attachments: [], replyTo: null, linkPreview: null } })
    const row = (e: typeof old, id: string): EncryptedMessage => ({ id, channelId, guildId, authorId: alice.userId, senderDevice: alice.deviceId, groupId: e.groupId, epoch: e.epoch, clientMsgId: e.clientMsgId, envelope: e.envelope, attachments: [], createdAt: '', editedAt: null })
    const [r0, r1] = await bob.messages.decryptMessages([row(old, 'm0'), row(now, 'm1')])
    expect(r0).toMatchObject({ status: 'ok', sender: { membershipVerified: false } })
    expect(r1).toMatchObject({ status: 'ok', sender: { membershipVerified: true } })
  }, 120_000)

  it('raises a fork alert on a GroupInfo mismatch and on AEAD failures, then resyncs', async () => {
    const { ds, c } = await world(['alice', 'bob', 'carol'])
    const { alice, bob, carol } = c as Record<'alice' | 'bob' | 'carol', Client>
    const { channelId, gid } = await channelGroup(ds, [alice, bob, carol])
    ds.tamperNext = (h) => ({ treeHash: toB64url(new Uint8Array(32)), confirmedTranscriptHash: h.next!.confirmedTranscriptHash })
    ds.channels.get(channelId)!.readers.delete(carol.userId)
    await ds.queueRemove(gid, carol.deviceId)
    await ds.flush()
    await alice.groups.sendState(channelId)
    ds.tamperNext = null
    await ds.flush()
    expect(bob.of<CryptoEvents['forkAlert']>('forkAlert')).toEqual([{ groupId: gid, channelId, epoch: 1, reason: 'group_info_mismatch' }])
    // bob resynced by external commit; alice processes it and both agree again.
    await alice.groups.sync()
    expect(await secretOf(alice, gid)).toBe(await secretOf(bob, gid))

    const e = (await epochOf(alice, gid))!
    await alice.groups.reportAeadFailure(fromB64url(gid), e, bob.deviceId)
    await alice.groups.reportAeadFailure(fromB64url(gid), e, bob.deviceId)
    expect(alice.of('forkAlert')).toHaveLength(0)
    await alice.groups.reportAeadFailure(fromB64url(gid), e, carol.deviceId)
    await ds.flush()
    expect(alice.of<CryptoEvents['forkAlert']>('forkAlert')).toEqual([{ groupId: gid, channelId, epoch: e, reason: 'aead_failures' }])
    expect(await epochOf(alice, gid)).toBe(e + 1)
  }, 120_000)

  it('rate-limits the aead_failures resync per group with exponential backoff', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    const { gid } = await channelGroup(ds, [alice, bob])
    const MIN = 10 * 60_000
    const burst = async () => {
      // One sender is enough: the header is not authenticated, so the count does not use it.
      for (let i = 0; i < 3; i++) await alice.groups.reportAeadFailure(fromB64url(gid), (await epochOf(alice, gid))!, bob.deviceId)
      await ds.flush()
      await alice.groups.idle()
      return alice.of('forkAlert').length
    }
    expect(await burst()).toBe(1)
    expect(await burst()).toBe(1)
    ds.id.now += MIN
    expect(await burst()).toBe(2)
    ds.id.now += MIN
    // The second wait is 20 minutes.
    expect(await burst()).toBe(2)
    ds.id.now += MIN
    expect(await burst()).toBe(3)
  }, 120_000)

  it('a device that rejects a DS-accepted commit raises a fork alert, resyncs with backoff and drains its buffer', async () => {
    const { ds, c } = await world(['alice', 'bob', 'carol'])
    const { alice, bob, carol } = c as Record<'alice' | 'bob' | 'carol', Client>
    const { guildId, channelId, gid } = await channelGroup(ds, [alice, bob])
    // The waits between resync attempts (no real time passes in the test).
    const waits: number[] = []
    ds.sleep = (ms) => {
      waits.push(ms)
      return Promise.resolve()
    }
    // The DS state fetch of the external commit fails 7 times: 5 attempts, then 2 more after sync().
    let stateFailures = 7
    const getGroupState = bob.transport.getGroupState
    bob.transport.getGroupState = (groupId, epoch) => (stateFailures-- > 0 ? Promise.reject(new DsError('ServiceUnavailable')) : getGroupState(groupId, epoch))
    // carol becomes a reader, but bob's permission view is stale: he rejects the Add that the DS accepts.
    ds.channels.get(channelId)!.readers.add(carol.userId)
    const readers = bob.transport.channelReaders
    bob.transport.channelReaders = () => Promise.resolve([alice.userId, bob.userId])
    await ds.queueAdd(gid, carol.deviceId)
    ds.batch(gid, alice.deviceId)
    await ds.flush()
    expect(await epochOf(alice, gid)).toBe(2)
    expect(await epochOf(bob, gid)).toBe(1)
    expect(bob.of<CryptoEvents['forkAlert']>('forkAlert')).toEqual([{ groupId: gid, channelId, epoch: 1, reason: 'commit_rejected' }])
    // Every attempt fails: the retry bound, then the group stays stopped (fail closed).
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    expect(bob.of<{ message: string }>('error').some((e) => e.message.includes('stays stopped after 5 resync attempts'))).toBe(true)
    await expect(bob.groups.sendState(channelId)).rejects.toMatchObject({ code: 'InvalidChain' })
    // An envelope of epoch 2 waits in bob's buffer.
    const sent = await alice.messages.encryptMessage({ channelId, kind: 'message', editOf: null, content: { text: 'epoch 2', mentions: [], attachments: [], replyTo: null, linkPreview: null } })
    const row = (e: typeof sent, id: string, from: Client): EncryptedMessage => ({ id, channelId, guildId, authorId: from.userId, senderDevice: from.deviceId, groupId: e.groupId, epoch: e.epoch, clientMsgId: e.clientMsgId, envelope: e.envelope, attachments: [], createdAt: '', editedAt: null })
    expect(await bob.messages.decryptMessages([row(sent, 'm2', alice)])).toEqual([{ status: 'pending', messageId: 'm2', reason: 'epoch_ahead' }])

    // bob's permission view catches up; the next sync() starts the attempts again.
    bob.transport.channelReaders = readers
    await bob.groups.sync()
    await bob.groups.idle()
    await ds.flush()
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 1_000, 2_000, 4_000])
    expect(await epochOf(bob, gid)).toBe(3)
    expect(await epochOf(alice, gid)).toBe(3)
    expect(await secretOf(bob, gid)).toBe(await secretOf(alice, gid))
    // The buffered envelope was drained (epochKeysAvailable for epoch 2).
    expect(bob.of<CryptoEvents['epochKeysAvailable']>('epochKeysAvailable').some((e) => e.groupId === gid && e.epochs.includes(2))).toBe(true)
    expect(await bob.store.get('buffered', gid)).toBeUndefined()
    // Bob sends again, and alice reads it.
    const back = await bob.messages.encryptMessage({ channelId, kind: 'message', editOf: null, content: { text: 'back', mentions: [], attachments: [], replyTo: null, linkPreview: null } })
    expect(back.epoch).toBe(3)
    const [r] = await alice.messages.decryptMessages([row(back, 'm3', bob)])
    expect(r).toMatchObject({ status: 'ok', content: { text: 'back' } })
    expect(ds.log.filter((l) => l.startsWith('Invalid') || l.startsWith('Illegal'))).toEqual([])
  }, 120_000)

  it('the committer reports a DS proposal it rejects by ProposalRef, so the batch does not stall', async () => {
    const { ds, c } = await world(['alice', 'bob', 'carol'])
    const { alice, bob, carol } = c as Record<'alice' | 'bob' | 'carol', Client>
    const guildId = ds.guild([alice.userId, bob.userId, carol.userId])
    const general = ds.channel(guildId, [alice.userId, bob.userId, carol.userId])
    const gid = ds.allocate('public_set', { guildId, channelId: null }, alice.deviceId)
    await ds.flush()
    await bob.groups.ensureChannelGroup(general)
    await ds.flush()
    ds.batch(gid, alice.deviceId)
    await ds.flush()
    expect(await epochOf(bob, gid)).toBe(1)
    // carol asks to join: bob stores the DS Add, then sees carol leave the guild before he commits.
    await carol.groups.ensureChannelGroup(general)
    await ds.flush()
    const ref = toB64url(ds.groups.get(gid)!.pending.find((p) => p.deviceId === carol.deviceId)!.proposal!.ref)
    bob.transport.guildMembers = () => Promise.resolve([alice.userId, bob.userId])
    const postCommit = bob.transport.postCommit
    const bodies: Parameters<typeof postCommit>[1][] = []
    bob.transport.postCommit = (groupId, body) => {
      bodies.push(body)
      return postCommit(groupId, body)
    }
    ds.batch(gid, bob.deviceId)
    await ds.flush()
    expect(bodies.at(-1)!.rejected).toEqual([{ proposalRef: ref, reason: 'not_reader' }])
    expect(ds.log).toContain('rejected proposal not_reader')
    expect(ds.groups.get(gid)!.pending.some((p) => p.deviceId === carol.deviceId)).toBe(false)
    // The commit went through without carol; alice follows.
    for (const x of [alice, bob]) expect(await epochOf(x, gid)).toBe(2)
    expect(await epochOf(carol, gid)).toBeNull()
    expect(await secretOf(alice, gid)).toBe(await secretOf(bob, gid))

    // A DS proposal that the committer rejects when it first sees it (not stored) is reported too.
    await ds.queueAdd(gid, carol.deviceId)
    await ds.flush()
    const again = toB64url(ds.groups.get(gid)!.pending.find((p) => p.deviceId === carol.deviceId)!.proposal!.ref)
    ds.batch(gid, bob.deviceId)
    await ds.flush()
    expect(bodies.at(-1)!.rejected).toEqual([{ proposalRef: again, reason: 'not_reader' }])
    for (const x of [alice, bob]) expect(await epochOf(x, gid)).toBe(3)
    expect(ds.log.filter((l) => l.startsWith('Invalid') || l.startsWith('Illegal'))).toEqual([])
  }, 120_000)

  it('shows extra users in the joiner timeline when the tree has users outside its own channelReaders', async () => {
    const { ds, c } = await world(['alice', 'bob', 'carol'])
    const { alice, bob, carol } = c as Record<'alice' | 'bob' | 'carol', Client>
    // carol's own permission computation says bob cannot read the channel.
    carol.transport.channelReaders = () => Promise.resolve([alice.userId, carol.userId])
    const { channelId } = await channelGroup(ds, [alice, bob, carol])
    const extra = (await carol.groups.membershipTimeline(channelId, 10)).filter((e) => e.kind === 'added' && e.actorUserId === null && e.subjects.every((s) => s.userId === bob.userId))
    expect(extra).toHaveLength(1)
    expect(extra[0]!.subjects).toEqual([{ userId: bob.userId, deviceId: bob.deviceId }])
  }, 120_000)

  it('resyncs after 410 HandshakesExpired and gets the missed epoch keys from an own device', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    const alice2 = await ds.client(alice.userId, { recoveryKey: (alice as Client & { recoveryKey: string }).recoveryKey })
    await ds.flush()
    const { gid } = await channelGroup(ds, [alice, alice2, bob])
    alice2.online = false
    // Two epochs pass while alice2 is offline, then the DS sweeps the old handshakes.
    for (let i = 0; i < 2; i++) {
      await bob.groups.resyncAll('fork')
      await ds.flush()
    }
    expect(await epochOf(alice, gid)).toBe(3)
    ds.groups.get(gid)!.expiredBefore = ds.groups.get(gid)!.handshakes.at(-1)!.seq
    alice2.online = true
    await alice2.groups.sync()
    await ds.flush()
    expect(await epochOf(alice2, gid)).toBe(4)
    expect(await secretOf(alice2, gid)).toBe(await secretOf(bob, gid))
    // Epochs 2 and 3 came from alice's device by history_keys.
    for (const e of [2, 3]) expect(toB64url((await alice2.groups.epochSecret(fromB64url(gid), e))!)).toBe(toB64url((await alice.groups.epochSecret(fromB64url(gid), e))!))
  }, 120_000)

  it('keeps the inbox cursor and exports and imports history keys', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    const { gid } = await channelGroup(ds, [alice, bob])
    expect((await bob.store.get('inbox', 'self'))!.lastSeq).toBeGreaterThan(0)
    expect(ds.inbox.get(bob.deviceId)).toEqual([])
    const keys = await alice.groups.exportHistoryKeys('all', 10)
    expect(keys.map((k) => k.epoch)).toEqual([0, 1])
    await bob.groups.importHistoryKeys(keys, 'own_device')
    expect(toB64url((await bob.groups.epochSecret(fromB64url(gid), 0))!)).toBe(toB64url(keys[0]!.secret))
    expect(bob.of<CryptoEvents['epochKeysAvailable']>('epochKeysAvailable').at(-1)).toEqual({ groupId: gid, epochs: [0] })
    expect(await bob.groups.leafAt(fromB64url(gid), alice.deviceId, 1)).toBe(0)
    expect(await bob.groups.leafAt(fromB64url(gid), alice.deviceId, 0)).toBeNull()
  }, 120_000)

  it('sends no history bundle for a joined group, even when the batch lists historyBundleEpochs', async () => {
    const { ds, c } = await world(['alice', 'bob', 'carol'])
    const { alice, bob, carol } = c as Record<'alice' | 'bob', Client> & { carol: Client }
    const { channelId, gid } = await channelGroup(ds, [alice, bob])
    ds.channels.get(channelId)!.readers.add(carol.userId)
    await ds.queueAdd(gid, carol.deviceId)
    ds.batch(gid, alice.deviceId, [1])
    await ds.flush()
    expect(await epochOf(carol, gid)).toBe(2)
    expect(ds.groups.get(gid)!.bundles).toEqual([])
    expect(await carol.groups.epochSecret(fromB64url(gid), 1)).toBeNull()
  }, 120_000)

  it('removes a revoked leaf by value before it sends when the DS queues no Remove', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    const alice2 = await ds.client(alice.userId, { recoveryKey: (alice as Client & { recoveryKey: string }).recoveryKey })
    await ds.flush()
    const { channelId, gid } = await channelGroup(ds, [alice, alice2, bob])
    await alice.identity.revokeDevice(alice2.deviceId, 'compromised')
    alice2.online = false
    await ds.flush()
    await bob.groups.sync()
    await ds.flush()
    const roster = async (x: Client) => mls.roster(await mls.restore((await x.store.get('groups', gid))!.state)).map((r) => r.deviceId)
    expect(await roster(bob)).toContain(alice2.deviceId)
    const send = await bob.groups.sendState(channelId)
    expect(await roster(bob)).not.toContain(alice2.deviceId)
    await ds.flush()
    expect(await secretOf(alice, gid)).toBe(toB64url(send.epochSecret))
    // IllegalMembership entries are alice's DSK-rotation resyncs: the fake DS (check 8) refuses a
    // tree that keeps the revoked leaf without a queued Remove. bob's commit passes every check.
    expect(ds.log.filter((l) => l.startsWith('Invalid'))).toEqual([])
  }, 120_000)

  it('a member without state processes the Welcome in its inbox instead of an external commit', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    bob.online = false
    const { channelId, gid } = await channelGroup(ds, [alice, bob])
    bob.online = true
    expect(await epochOf(bob, gid)).toBeNull()
    await bob.groups.ensureChannelGroup(channelId)
    await ds.flush()
    expect(await epochOf(bob, gid)).toBe(1)
    expect(ds.groups.get(gid)!.handshakes.map((h) => h.kind)).toEqual(['commit'])
    expect(await secretOf(bob, gid)).toBe(await secretOf(alice, gid))
  }, 120_000)

  it('InvitePort.ownCommit fires after each own accepted commit, never after a commit of another device; joined after a Welcome', async () => {
    const { ds, c } = await world(['alice', 'bob', 'carol'])
    const { alice, bob, carol } = c as Record<'alice' | 'bob' | 'carol', Client>
    const seen: { device: string; gid: string; epoch: number }[] = []
    const joins: { device: string; gid: string; epoch: number }[] = []
    const record = (list: typeof seen, x: Client) => (e: { groupId: Uint8Array; epoch: number }) => {
      list.push({ device: x.deviceId, gid: toB64url(e.groupId), epoch: e.epoch })
    }
    for (const x of [alice, bob]) x.groups.attachInvites(testPort({ ownCommit: record(seen, x), joined: record(joins, x) }))
    // A later attachInvites replaces the port.
    const replaced: unknown[] = []
    carol.groups.attachInvites(testPort({ joined: (e) => replaced.push(e) }))
    carol.groups.attachInvites(testPort({ joined: record(joins, carol) }))
    // The batch commit of the Adds.
    const { channelId, gid } = await channelGroup(ds, [alice, bob, carol])
    expect(seen).toEqual([{ device: alice.deviceId, gid, epoch: 1 }])
    expect(replaced).toEqual([])
    expect(joins).toEqual([
      { device: bob.deviceId, gid, epoch: 1 },
      { device: carol.deviceId, gid, epoch: 1 },
    ])
    // A commit before a send, and an external commit (resync).
    ds.channels.get(channelId)!.readers.delete(carol.userId)
    await ds.queueRemove(gid, carol.deviceId)
    await ds.flush()
    await bob.groups.sendState(channelId)
    await ds.flush()
    await alice.groups.resyncAll('fork')
    await ds.flush()
    expect(seen).toEqual([
      { device: alice.deviceId, gid, epoch: 1 },
      { device: bob.deviceId, gid, epoch: 2 },
      { device: alice.deviceId, gid, epoch: 3 },
    ])
    // A resync is no join.
    expect(joins).toHaveLength(2)
    expect(await bob.groups.descriptor(fromB64url(gid))).toMatchObject({ kind: 'channel', channelId })
    expect(await carol.groups.descriptor(fromB64url(gid))).toBeNull()
  }, 120_000)

  it('the secret from the MLS state replaces an imported secret of the epoch that the device enters', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    const { channelId, gid } = await channelGroup(ds, [alice, bob])
    // A bundle that any member can sign (§12.11.4) gave bob a wrong secret for the next epoch.
    await bob.groups.importHistoryKeys([{ groupId: fromB64url(gid), epoch: 2, secret: new Uint8Array(32).fill(7) }], 'bundle')
    await alice.groups.resyncAll('fork')
    await ds.flush()
    expect(await epochOf(bob, gid)).toBe(2)
    expect(await secretOf(bob, gid)).toBe(await secretOf(alice, gid))
    expect(bob.of<CryptoEvents['epochKeysAvailable']>('epochKeysAvailable').filter((e) => e.groupId === gid)).toEqual([
      { groupId: gid, epochs: [2] },
      { groupId: gid, epochs: [2] },
    ])
    expect(toB64url((await bob.groups.sendState(channelId)).epochSecret)).toBe(await secretOf(alice, gid))
  }, 120_000)

  it('a load outside the lock does not cache a handle that a locked caller removed meanwhile', async () => {
    const { ds, c } = await world(['alice', 'bob', 'carol'])
    const { alice, bob, carol } = c as Record<'alice' | 'bob' | 'carol', Client>
    const { channelId, gid } = await channelGroup(ds, [alice, bob, carol])
    // A new service on carol's store (no cached handle). Its first restore waits for the gate.
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))
    let first = true
    const restore = async (state: Uint8Array) => {
      const h = await mls.restore(state)
      if (first) {
        first = false
        await gate
      }
      return h
    }
    const svc = createGroupService(carol.ctx, carol.identity, { mls: { ...mls, restore } })
    carol.groups = svc
    const pending = svc.descriptor(fromB64url(gid))
    // alice removes carol. The locked path restores, processes the commit and deletes the state.
    ds.channels.get(channelId)!.readers.delete(carol.userId)
    await ds.queueRemove(gid, carol.deviceId)
    await ds.flush()
    await alice.groups.sendState(channelId)
    await ds.flush()
    expect((await carol.store.get('groups', gid))!.state.length).toBe(0)
    open()
    expect(await pending).toBeNull()
    expect(await svc.currentEpoch(fromB64url(gid))).toBeNull()
  }, 120_000)

  describe('usersAdded (§12.20 "Access by new members")', () => {
    type UsersAdded = CryptoEvents['usersAdded']

    it('fires on the committer and on the members for a new user, never on the joiner', async () => {
      const { ds, c } = await world(['alice', 'bob', 'carol'])
      const { alice, bob, carol } = c as Record<'alice' | 'bob' | 'carol', Client>
      const { guildId, channelId, gid: channel } = await channelGroup(ds, [alice, bob])
      expect(alice.of<UsersAdded>('usersAdded')).toEqual([{ groupId: channel, kind: 'channel', guildId, channelId, epoch: 1, userIds: [bob.userId], byMe: true }])
      expect(bob.of('usersAdded')).toEqual([])

      ds.guilds.get(guildId)!.add(carol.userId)
      const general = ds.channel(guildId, [alice.userId, bob.userId, carol.userId])
      const gid = ds.allocate('public_set', { guildId, channelId: null }, alice.deviceId)
      await ds.flush()
      await bob.groups.ensureChannelGroup(general)
      await ds.flush()
      ds.batch(gid, alice.deviceId)
      await ds.flush()
      await carol.groups.ensureChannelGroup(general)
      await ds.flush()
      ds.batch(gid, bob.deviceId)
      await ds.flush()
      const added = (x: Client) => x.of<UsersAdded>('usersAdded').filter((e) => e.groupId === gid)
      expect(added(alice)).toEqual([
        { groupId: gid, kind: 'public_set', guildId, channelId: null, epoch: 1, userIds: [bob.userId], byMe: true },
        { groupId: gid, kind: 'public_set', guildId, channelId: null, epoch: 2, userIds: [carol.userId], byMe: false },
      ])
      expect(added(bob)).toEqual([{ groupId: gid, kind: 'public_set', guildId, channelId: null, epoch: 2, userIds: [carol.userId], byMe: true }])
      expect(carol.of('usersAdded')).toEqual([])

      // A resync and a new device of a member add no new user.
      const count = () => [alice, bob, carol].map((x) => x.of('usersAdded').length)
      const before = count()
      await bob.groups.resyncAll('fork')
      await ds.flush()
      const alice2 = await ds.client(alice.userId, { recoveryKey: (alice as Client & { recoveryKey: string }).recoveryKey })
      await ds.flush()
      await alice2.groups.ensureChannelGroup(general)
      await ds.flush()
      ds.batch(gid, carol.deviceId)
      await ds.flush()
      expect(await epochOf(alice2, gid)).toBe(4)
      expect(count()).toEqual(before)
      expect(alice2.of('usersAdded')).toEqual([])
    }, 120_000)

    it('fires on a member that processes an external join later', async () => {
      const { ds, c } = await world(['alice', 'bob'])
      const { alice, bob } = c as Record<'alice' | 'bob', Client>
      const guildId = ds.guild([alice.userId, bob.userId])
      const general = ds.channel(guildId, [alice.userId, bob.userId])
      const gid = ds.allocate('public_set', { guildId, channelId: null }, alice.deviceId)
      await ds.flush()
      alice.online = false
      await bob.groups.ensureChannelGroup(general)
      const req = [...ds.joinRequests.values()].find((r) => r.deviceId === bob.deviceId)!
      ds.groups.get(gid)!.pending = []
      ds.joinUpdate(req.id, 'external_commit')
      await ds.flush()
      alice.online = true
      await alice.groups.sync()
      expect(alice.of<UsersAdded>('usersAdded')).toEqual([{ groupId: gid, kind: 'public_set', guildId, channelId: null, epoch: 1, userIds: [bob.userId], byMe: false }])
      expect(bob.of('usersAdded')).toEqual([])
    }, 120_000)

    it('fires once when the committer adopts its own Add commit after a lost response', async () => {
      const { ds, c } = await world(['alice', 'bob'])
      const { alice, bob } = c as Record<'alice' | 'bob', Client>
      const guildId = ds.guild([alice.userId, bob.userId])
      const general = ds.channel(guildId, [alice.userId, bob.userId])
      const gid = ds.allocate('public_set', { guildId, channelId: null }, alice.deviceId)
      await ds.flush()
      await bob.groups.ensureChannelGroup(general)
      await ds.flush()
      // The DS stores the commit, but the response never reaches alice: the stream adopts it.
      const post = alice.transport.postCommit.bind(alice.transport)
      alice.transport.postCommit = async (g, body) => {
        await post(g, body)
        throw new DsError('Timeout')
      }
      ds.batch(gid, alice.deviceId)
      await ds.flush()
      alice.transport.postCommit = post
      expect(await epochOf(alice, gid)).toBe(1)
      expect(alice.of<UsersAdded>('usersAdded')).toEqual([{ groupId: gid, kind: 'public_set', guildId, channelId: null, epoch: 1, userIds: [bob.userId], byMe: true }])
    }, 120_000)
  })
})
