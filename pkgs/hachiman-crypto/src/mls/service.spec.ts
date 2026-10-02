import { describe, expect, it } from 'vitest'

import type { CryptoEvents, EncryptedMessage } from '../api'
import { fromB64url, toB64url } from '../codec'
import { DsError } from '../identity/test-helpers'
import { FakeMlsDs, leafGeneration, type Client } from './fake-ds'
import { mls } from './index'
import { keyPackage, makeDevice, makeUser } from './test-helpers'

async function world(names: string[]): Promise<{ ds: FakeMlsDs; c: Record<string, Client> }> {
  const ds = await new FakeMlsDs().init()
  const c: Record<string, Client> = {}
  for (const n of names) c[n] = await ds.client(ds.uuid())
  await ds.flush()
  return { ds, c }
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
    await bob.groups.ensureChannelGroup(general)
    const req = [...ds.joinRequests.values()].find((r) => r.deviceId === bob.deviceId)!
    ds.groups.get(gid)!.pending = []
    ds.joinUpdate(req.id, 'external_commit')
    await ds.flush()
    expect(await epochOf(bob, gid)).toBe(1)
    alice.online = true
    await alice.groups.sync()
    expect(await secretOf(alice, gid)).toBe(await secretOf(bob, gid))
    expect((await alice.groups.membershipTimeline(general, 10)).at(-1)).toMatchObject({ kind: 'joined_external', actorUserId: null })
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

  it('shares history in a shared group: the joiner reads old epochs with membershipVerified false', async () => {
    const { ds, c } = await world(['alice', 'bob'])
    const { alice, bob } = c as Record<'alice' | 'bob', Client>
    const guildId = ds.guild([alice.userId, bob.userId])
    const channelId = ds.channel(guildId, [alice.userId, bob.userId])
    const gid = ds.allocate('channel', { guildId, channelId }, alice.deviceId, 'shared')
    await ds.flush()
    ds.groups.get(gid)!.pending = []
    // An epoch-0 message: only alice is a member.
    const old = await alice.messages.encryptMessage({ channelId, kind: 'message', editOf: null, content: { text: 'before you came', mentions: [], attachments: [], replyTo: null } })
    await ds.queueAdd(gid, bob.deviceId)
    ds.batch(gid, alice.deviceId)
    await ds.flush()
    expect(ds.groups.get(gid)!.bundles.map((b) => b.epoch)).toEqual([1])
    const now = await alice.messages.encryptMessage({ channelId, kind: 'message', editOf: null, content: { text: 'hello', mentions: [], attachments: [], replyTo: null } })
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
    expect(bob.of<CryptoEvents['forkAlert']>('forkAlert')).toEqual([{ groupId: gid, channelId, reason: 'group_info_mismatch' }])
    // bob resynced by external commit; alice processes it and both agree again.
    await alice.groups.sync()
    expect(await secretOf(alice, gid)).toBe(await secretOf(bob, gid))

    const e = (await epochOf(alice, gid))!
    await alice.groups.reportAeadFailure(fromB64url(gid), e, bob.deviceId)
    await alice.groups.reportAeadFailure(fromB64url(gid), e, bob.deviceId)
    expect(alice.of('forkAlert')).toHaveLength(0)
    await alice.groups.reportAeadFailure(fromB64url(gid), e, carol.deviceId)
    await ds.flush()
    expect(alice.of<CryptoEvents['forkAlert']>('forkAlert')).toEqual([{ groupId: gid, channelId, reason: 'aead_failures' }])
    expect(await epochOf(alice, gid)).toBe(e + 1)
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
})
