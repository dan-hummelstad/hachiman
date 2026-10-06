import { describe, expect, it, vi } from 'vitest'

import type { AdminPayload, CryptoEvents, EncryptedMessage, EncryptMessageOutput, IdentityService } from '../api'
import { AdminBits, admin } from '../admin/index'
import { createAdminService } from '../admin/service'
import { fromB64url, toB64url, uuidToBytes } from '../codec'
import { INVITE_BUNDLE_FETCH_WINDOW_MS } from '../constants'
import { compareBytes, randomBytes } from '../identity/bytes'
import { FakeMlsDs, type Client } from '../mls/fake-ds'
import { groupId as makeGroupId } from '../mls/wire'
import { clientPermissions } from '../worker/permissions'
import { decodeInviteRecord, decodeSignedInviteRecord, encodeInviteBundle, encodeSignedInviteRecord } from './codec'
import { deriveInviteKeys, sealInviteBundle } from './keys'
import { signInviteBundle, signInviteRecord } from './record'
import { createInviteService, INVITE_REFETCH_DELAY_MS } from './service'

const DAY = 86_400_000
const opts = { invitePermissions: clientPermissions }

/** Signs an admin action with `actor` and stores it, as the role and overwrite routes do (§12.16). */
async function act(ds: FakeMlsDs, actor: Client, guildId: string, payload: AdminPayload): Promise<void> {
  const a = await createAdminService(actor.ctx, actor.identity).signAdminAction(guildId, payload.type, admin.encodePayload(payload))
  ds.id.storeAdminAction(guildId, a.header)
}

/** alice owns the guild, bob is a member, carol redeems later. The public_set group is at epoch 1. */
async function world() {
  const ds = await new FakeMlsDs().init()
  const alice = await ds.client(ds.uuid(), opts)
  const bob = await ds.client(ds.uuid(), opts)
  const carol = await ds.client(ds.uuid(), opts)
  await ds.flush()
  const guildId = ds.guild([alice.userId, bob.userId])
  const general = ds.channel(guildId, [alice.userId, bob.userId])
  await act(ds, alice, guildId, { type: 0, ownerId: alice.userId })
  const gid = ds.allocate('public_set', { guildId, channelId: null }, alice.deviceId)
  await ds.flush()
  await bob.groups.ensureChannelGroup(general)
  await ds.flush()
  ds.batch(gid, alice.deviceId)
  await ds.flush()
  return { ds, alice, bob, carol, guildId, general, gid }
}

/** An invite with history by `creator`, stored as POST /guilds/:id/invites does, with its creation bundles. */
async function invite(ds: FakeMlsDs, creator: Client, guildId: string, channelIds: string[]) {
  const p = await creator.invites!.prepareHistoryInvite({ guildId, channelIds, expiresAtMs: ds.id.now + DAY, maxUses: 1 })
  const { inviteId, code } = ds.createInvite(guildId, p.record)
  const sent = await creator.invites!.sendInviteBundles({ guildId, inviteId, record: p.record })
  return { ...p, inviteId, code, sent, keyId: toB64url(decodeInviteRecord(decodeSignedInviteRecord(fromB64url(p.record)).record).signPublic) }
}

async function send(from: Client, channelId: string, text: string): Promise<EncryptMessageOutput> {
  return from.messages.encryptMessage({ channelId, kind: 'message', editOf: null, content: { text, mentions: [], attachments: [], replyTo: null } })
}

function row(from: Client, channelId: string, guildId: string, e: EncryptMessageOutput, id: string): EncryptedMessage {
  return { id, channelId, guildId, authorId: from.userId, senderDevice: from.deviceId, groupId: e.groupId, epoch: e.epoch, clientMsgId: e.clientMsgId, envelope: e.envelope, attachments: [], createdAt: '', editedAt: null }
}

/** A new member of the guild that joins public_set through a batch of `committer`: one own commit of it. */
async function addMember(ds: FakeMlsDs, guildId: string, channelId: string, gid: string, committer: Client): Promise<Client> {
  const c = await ds.client(ds.uuid())
  await ds.flush()
  ds.guilds.get(guildId)!.add(c.userId)
  await c.groups.ensureChannelGroup(channelId)
  await ds.flush()
  ds.batch(gid, committer.deviceId)
  await ds.flush()
  return c
}

/** `c` joins public_set by its own external commit (no member online for a batch). */
async function joinPublicSet(ds: FakeMlsDs, c: Client, channelId: string, gid: string): Promise<void> {
  await c.groups.ensureChannelGroup(channelId)
  const req = [...ds.joinRequests.values()].find((r) => r.deviceId === c.deviceId)!
  ds.groups.get(gid)!.pending = []
  ds.joinUpdate(req.id, 'external_commit')
  await ds.flush()
}

/** A bundle that `from` signs with its own device key, for any epochs it likes. */
async function forgeBundle(from: Client, signedRecord: string, gid: string, keys: { epoch: number; secret: Uint8Array }[]): Promise<string> {
  const rec = decodeInviteRecord(decodeSignedInviteRecord(fromB64url(signedRecord)).record)
  const self = from.identity.self()
  const content = signInviteBundle({ signPublic: rec.signPublic, groupId: fromB64url(gid), keys, senderUserId: self.userId, senderDeviceId: self.deviceId }, self.mlsSignatureKey.privateKey)
  return toB64url(await sealInviteBundle(rec, fromB64url(gid), content))
}

/** An InviteService of `c` whose identity answers `over` instead. */
function withIdentity(c: Client, over: Partial<IdentityService>) {
  return createInviteService(c.ctx, { ...c.identity, ...over }, c.groups, clientPermissions)
}

const errors = (c: Client) => c.of<{ message: string }>('error').map((e) => e.message)

const bundlesOf = (ds: FakeMlsDs, inviteId: string) => ds.invites.get(inviteId)!.bundles.map((b) => [b.senderDevice, b.epoch])

describe('InviteService (§12.11.4)', () => {
  it('creation and commit bundles open for the redeemer; the keys give membershipVerified false', async () => {
    const { ds, alice, bob, carol, guildId, general, gid } = await world()
    const old = await send(alice, general, 'before the invite')
    const inv = await invite(ds, alice, guildId, [general])
    expect(inv.channelIds).toEqual([general])
    expect(inv.linkSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(inv.sent).toEqual({ groups: 1 })
    expect((await alice.groups.membershipTimeline(general, 10)).at(-1)).toMatchObject({ kind: 'invite_with_history', actorUserId: alice.userId, subjects: [], inviteKeyId: inv.keyId })

    // A reader raises the `bundled` hint to the next epoch with a bundle that does not open. bob's
    // commit of that epoch still sends it.
    const junk = encodeInviteBundle({ enc: randomBytes(32), ciphertext: randomBytes(120) })
    ds.invites.get(inv.inviteId)!.bundles.push({ groupId: gid, epoch: 2, blob: toB64url(junk), senderDevice: bob.deviceId, senderUser: bob.userId })
    await addMember(ds, guildId, general, gid, bob)
    expect(bundlesOf(ds, inv.inviteId)).toEqual([
      [alice.deviceId, 1],
      [bob.deviceId, 2],
      [bob.deviceId, 2],
    ])
    expect(bob.of('error')).toEqual([])
    // bob checked the record for the first time: the timeline shows the invite.
    expect((await bob.groups.membershipTimeline(general, 10)).filter((e) => e.kind === 'invite_with_history')).toMatchObject([{ actorUserId: alice.userId }])
    expect((await bob.store.get('invites', inv.keyId))?.bundled).toEqual({ [gid]: 2 })

    const later = await send(alice, general, 'after the invite')
    expect(later.epoch).toBe(2)
    ds.acceptInvite(inv.code, carol.userId)
    expect(await carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })).toEqual({ groups: 1, keys: 3 })
    // The raised bundle does not open: it is dropped alone.
    expect(carol.of<{ message: string }>('error').map((e) => e.message)).toEqual(['invite bundle does not open for this invite and group'])
    const [a, b] = await carol.messages.decryptMessages([row(alice, general, guildId, old, 'm1'), row(alice, general, guildId, later, 'm2')])
    expect(a).toMatchObject({ status: 'ok', content: { text: 'before the invite' }, sender: { userId: alice.userId, membershipVerified: false } })
    expect(b).toMatchObject({ status: 'ok', content: { text: 'after the invite' }, sender: { membershipVerified: false } })
    const stored = await carol.store.get('invites', inv.keyId)
    expect(stored).toMatchObject({ role: 'redeemed', inviteId: inv.inviteId, revoked: false, guildId, redeemedAtMs: ds.id.now })
    expect(toB64url(stored!.seed!)).toBe(inv.linkSecret)
  }, 120_000)

  it('sendInviteBundles rejects with the error of a failed post, so the caller can revoke the invite', async () => {
    const { ds, alice, guildId, general } = await world()
    const p = await alice.invites!.prepareHistoryInvite({ guildId, channelIds: [general], expiresAtMs: ds.id.now + DAY, maxUses: 1 })
    const { inviteId } = ds.createInvite(guildId, p.record)
    // Takusen refuses the post (here: the invite was revoked in the meantime).
    ds.invites.get(inviteId)!.revoked = true
    await expect(alice.invites!.sendInviteBundles({ guildId, inviteId, record: p.record })).rejects.toMatchObject({ code: 'Transport', dsCode: 'UnknownInvite' })
    expect(ds.invites.get(inviteId)!.bundles).toEqual([])
    expect(alice.of('error')).toEqual([])
  }, 120_000)

  it('a commit bundle fills the epochs that a committer without the service left out', async () => {
    const { ds, alice, bob, guildId, general, gid } = await world()
    const inv = await invite(ds, alice, guildId, [general])
    // dave has no InviteService (an old client): his commit of epoch 2 sends nothing.
    const dave = await addMember(ds, guildId, general, gid, alice)
    expect(bundlesOf(ds, inv.inviteId)).toEqual([
      [alice.deviceId, 1],
      [alice.deviceId, 2],
    ])
    await dave.groups.resyncAll('fork')
    await ds.flush()
    await bob.groups.resyncAll('fork')
    await ds.flush()
    expect(await bob.groups.currentEpoch(fromB64url(gid))).toBe(4)
    expect(bundlesOf(ds, inv.inviteId).at(-1)).toEqual([bob.deviceId, 4])
    // The bundle of bob carries epochs 3 and 4: open it as the redeemer does.
    const carol = await ds.client(ds.uuid(), opts)
    await ds.flush()
    ds.invites.get(inv.inviteId)!.bundles = ds.invites.get(inv.inviteId)!.bundles.slice(-1)
    ds.acceptInvite(inv.code, carol.userId)
    expect(await carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })).toEqual({ groups: 1, keys: 2 })
    for (const e of [3, 4]) expect(toB64url((await carol.groups.epochSecret(fromB64url(gid), e))!)).toBe(toB64url((await bob.groups.epochSecret(fromB64url(gid), e))!))
  }, 120_000)

  it('scope: only channels that @everyone views; a channel group leaves the scope with its @everyone VIEW_CHANNEL', async () => {
    const { ds, alice, bob, guildId, general, gid } = await world()
    const side = ds.channel(guildId, [alice.userId, bob.userId])
    const secret = ds.channel(guildId, [alice.userId])
    await act(ds, alice, guildId, { type: 5, channelId: secret, targetId: guildId, targetType: 'role', allow: 0, deny: AdminBits.VIEW_CHANNEL })
    const sideGid = ds.allocate('channel', { guildId, channelId: side }, alice.deviceId)
    await ds.flush()
    ds.batch(sideGid, alice.deviceId)
    await ds.flush()
    const dm = ds.channel(null, [alice.userId, bob.userId])
    const dmGid = ds.allocate('dm', { guildId: null, channelId: dm }, alice.deviceId)
    await ds.flush()
    ds.batch(dmGid, alice.deviceId)
    await ds.flush()

    const inv = await invite(ds, alice, guildId, [secret, side, general, side])
    expect(inv.channelIds).toEqual([general, side].sort((x, y) => compareBytes(uuidToBytes(x), uuidToBytes(y))))
    // public_set and the side channel group; never the DM group.
    expect(inv.sent).toEqual({ groups: 2 })
    expect(new Set(ds.invites.get(inv.inviteId)!.bundles.map((b) => b.groupId))).toEqual(new Set([sideGid, gid]))

    // @everyone loses VIEW_CHANNEL on the side channel: no more bundles for its group.
    await act(ds, alice, guildId, { type: 5, channelId: side, targetId: guildId, targetType: 'role', allow: 0, deny: AdminBits.VIEW_CHANNEL })
    await bob.groups.resyncAll('fork')
    await ds.flush()
    expect(bundlesOf(ds, inv.inviteId).filter(([d]) => d === bob.deviceId)).toHaveLength(1)
    expect(ds.invites.get(inv.inviteId)!.bundles.filter((b) => b.senderDevice === bob.deviceId).map((b) => b.groupId)).not.toContain(sideGid)

    // Not an administrator, or no admin state: Unsupported.
    await expect(bob.invites!.prepareHistoryInvite({ guildId, channelIds: [general], expiresAtMs: 0, maxUses: 0 })).rejects.toMatchObject({ code: 'Unsupported' })
    await expect(alice.invites!.prepareHistoryInvite({ guildId, channelIds: [secret], expiresAtMs: 0, maxUses: 0 })).rejects.toMatchObject({ code: 'Unsupported' })
    const other = ds.guild([alice.userId])
    await expect(alice.invites!.prepareHistoryInvite({ guildId: other, channelIds: [general], expiresAtMs: 0, maxUses: 0 })).rejects.toMatchObject({ code: 'Unsupported' })
    await expect(alice.invites!.prepareHistoryInvite({ guildId, channelIds: ['not-a-uuid'], expiresAtMs: 0, maxUses: 0 })).rejects.toMatchObject({ code: 'Malformed' })
  }, 120_000)

  it('a demoted creator: members send no bundle, the redeemer rejects the record', async () => {
    const { ds, alice, bob, carol, guildId, general } = await world()
    const role = ds.uuid()
    await act(ds, alice, guildId, { type: 1, roleId: role, permissions: AdminBits.ADMINISTRATOR, position: 1 })
    await act(ds, alice, guildId, { type: 7, userId: bob.userId, roleIds: [role] })
    const inv = await invite(ds, bob, guildId, [general])
    expect(inv.sent).toEqual({ groups: 1 })
    await act(ds, alice, guildId, { type: 7, userId: bob.userId, roleIds: [] })
    await alice.groups.resyncAll('fork')
    await ds.flush()
    expect(bundlesOf(ds, inv.inviteId)).toEqual([[bob.deviceId, 1]])
    expect(await alice.store.get('invites', inv.keyId)).toBeUndefined()
    ds.acceptInvite(inv.code, carol.userId)
    await expect(carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })).rejects.toMatchObject({ code: 'InvalidChain', message: expect.stringContaining('not an administrator') as string })
    expect(await carol.groups.exportHistoryKeys('all', 10)).toEqual([])
  }, 120_000)

  it('a changed or swapped record, a moved bundle, a foreign or revoked sender: rejected', async () => {
    const { ds, alice, bob, carol, guildId, general, gid } = await world()
    const rk = (alice as Client & { recoveryKey: string }).recoveryKey
    const alice2 = await ds.client(alice.userId, { recoveryKey: rk })
    await ds.flush()
    // alice revokes alice2 (and resyncs after her DSK rotation). alice2 still holds its key.
    const self2 = alice2.identity.self()
    await alice.identity.revokeDevice(self2.deviceId, 'lost')
    alice2.online = false
    await ds.flush()
    const inv = await invite(ds, alice, guildId, [general])
    const other = await invite(ds, alice, guildId, [general])
    const stored = ds.invites.get(inv.inviteId)!
    const rec = decodeInviteRecord(decodeSignedInviteRecord(fromB64url(inv.record)).record)
    const keys = (await alice.groups.exportHistoryKeys([fromB64url(gid)], 10)).map((k) => ({ epoch: k.epoch, secret: k.secret }))

    // A bundle that names alice's device but carries the signature of bob's device.
    const forged = signInviteBundle({ signPublic: rec.signPublic, groupId: fromB64url(gid), keys, senderUserId: alice.userId, senderDeviceId: alice.deviceId }, bob.identity.self().mlsSignatureKey.privateKey)
    stored.bundles.push({ groupId: gid, epoch: 1, blob: toB64url(await sealInviteBundle(rec, fromB64url(gid), forged)), senderDevice: alice.deviceId, senderUser: alice.userId })
    // A bundle of alice2, signed with its own key.
    const fromRevoked = signInviteBundle({ signPublic: rec.signPublic, groupId: fromB64url(gid), keys, senderUserId: alice.userId, senderDeviceId: self2.deviceId }, self2.mlsSignatureKey.privateKey)
    stored.bundles.push({ groupId: gid, epoch: 1, blob: toB64url(await sealInviteBundle(rec, fromB64url(gid), fromRevoked)), senderDevice: self2.deviceId, senderUser: alice.userId })
    // alice's real bundle moved to another group of the scope (the next public_set generation): the
    // AAD differs, so it does not open.
    const moved = { ...stored.bundles[0]!, groupId: toB64url(makeGroupId({ kind: 'public_set', scope: guildId, generation: 1 })) }

    ds.acceptInvite(inv.code, carol.userId)
    const real = stored.bundles
    stored.bundles = [moved, ...real.slice(1)]
    expect(await carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })).toEqual({ groups: 0, keys: 0 })
    expect(carol.of<{ message: string }>('error').map((e) => e.message)).toEqual([
      'invite bundle does not open for this invite and group',
      'invite bundle: bad signature, or another invite or group',
      // The revocation rotated alice's DSK, so the old certificate of alice2 no longer verifies.
      expect.stringMatching(/^invite bundle: (unknown sender device|the sender device is revoked)/),
    ])
    stored.bundles = real
    expect(await carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })).toEqual({ groups: 1, keys: keys.length })

    // The server gives the record of another invite, or a changed record.
    stored.record = other.record
    await expect(carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })).rejects.toMatchObject({ code: 'InvalidChain', message: expect.stringContaining('not the record of this link') as string })
    // One bit of expires_at_ms: the keys stay, so only the signature catches it.
    const signed = decodeSignedInviteRecord(fromB64url(inv.record))
    const tampered = toB64url(encodeSignedInviteRecord({ record: signed.record.map((x, i, all) => (i === all.length - 40 ? x ^ 1 : x)), signature: signed.signature }))
    expect(decodeInviteRecord(decodeSignedInviteRecord(fromB64url(tampered)).record).expiresAtMs).not.toBe(rec.expiresAtMs)
    stored.record = tampered
    await expect(carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })).rejects.toMatchObject({ code: 'InvalidChain', message: expect.stringContaining('bad signature') as string })
    // Members do not send bundles for the changed record either.
    const before = stored.bundles.length
    await bob.groups.resyncAll('fork')
    await ds.flush()
    expect(stored.bundles.length).toBe(before)
    // A link secret of the wrong length.
    await expect(carol.invites!.redeemInvite({ code: inv.code, linkSecret: toB64url(randomBytes(16)) })).rejects.toMatchObject({ code: 'Malformed' })
  }, 120_000)

  it('INVITE_DELETE: a member marks the invite revoked and sends no more bundles for it; a redeemer wipes the seed', async () => {
    const { ds, alice, bob, carol, guildId, general } = await world()
    const inv = await invite(ds, alice, guildId, [general])
    await bob.groups.resyncAll('fork')
    await ds.flush()
    expect(bundlesOf(ds, inv.inviteId)).toEqual([
      [alice.deviceId, 1],
      [bob.deviceId, 2],
    ])
    ds.acceptInvite(inv.code, carol.userId)
    await carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })
    expect((await carol.store.get('invites', inv.keyId))?.seed).not.toBeNull()
    ds.revokeInvite(inv.inviteId)
    await ds.flush()
    expect(await bob.store.get('invites', inv.keyId)).toMatchObject({ revoked: true, seed: null })
    expect(await alice.store.get('invites', inv.keyId)).toMatchObject({ revoked: true })
    expect(await carol.store.get('invites', inv.keyId)).toMatchObject({ role: 'redeemed', revoked: true, seed: null })
    // A server that lists the invite again gets no bundle.
    ds.invites.get(inv.inviteId)!.revoked = false
    ds.id.now += 61_000
    await bob.groups.resyncAll('fork')
    await alice.groups.resyncAll('fork')
    await ds.flush()
    expect(bundlesOf(ds, inv.inviteId)).toEqual([])
    expect([...bob.of<{ message: string }>('error'), ...alice.of<{ message: string }>('error')]).toEqual([])
  }, 120_000)

  it('a bundle of another member cannot replace the keys of the creator or set the keys of later epochs', async () => {
    const { ds, alice, bob, carol, guildId, general, gid } = await world()
    const old = await send(alice, general, 'before the invite')
    const inv = await invite(ds, alice, guildId, [general])
    const stored = ds.invites.get(inv.inviteId)!
    const junk = (epochs: number[]) => epochs.map((epoch) => ({ epoch, secret: randomBytes(32) }))
    // bob posts first, at the group epoch 1: a wrong epoch 1 and epochs that do not exist yet.
    stored.bundles.unshift({ groupId: gid, epoch: 1, blob: await forgeBundle(bob, inv.record, gid, junk([1, 2, 3, 4])), senderDevice: bob.deviceId, senderUser: bob.userId })
    // A server that lies about the bundle epoch gets a wrong epoch 2 in.
    stored.bundles.push({ groupId: gid, epoch: 9, blob: await forgeBundle(bob, inv.record, gid, junk([1, 2])), senderDevice: bob.deviceId, senderUser: bob.userId })
    ds.acceptInvite(inv.code, carol.userId)
    // alice's 0 and 1, and the 2 of the lying server.
    expect(await carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })).toEqual({ groups: 1, keys: 3 })
    expect(errors(carol)).toEqual([])
    expect(toB64url((await carol.groups.epochSecret(fromB64url(gid), 1))!)).toBe(toB64url((await alice.groups.epochSecret(fromB64url(gid), 1))!))
    expect(await carol.groups.epochSecret(fromB64url(gid), 3)).toBeNull()
    const [a] = await carol.messages.decryptMessages([row(alice, general, guildId, old, 'm1')])
    expect(a).toMatchObject({ status: 'ok', content: { text: 'before the invite' } })

    // carol joins at epoch 2: the secret from her MLS state replaces the imported one.
    await joinPublicSet(ds, carol, general, gid)
    expect(await carol.groups.currentEpoch(fromB64url(gid))).toBe(2)
    expect(toB64url((await carol.groups.epochSecret(fromB64url(gid), 2))!)).toBe(toB64url((await alice.groups.epochSecret(fromB64url(gid), 2))!))
    expect(carol.of<CryptoEvents['epochKeysAvailable']>('epochKeysAvailable').at(-1)).toEqual({ groupId: gid, epochs: [2] })
    const fromAlice = await send(alice, general, 'to carol')
    const fromCarol = await send(carol, general, 'to alice')
    expect(fromCarol.epoch).toBe(2)
    expect(await carol.messages.decryptMessages([row(alice, general, guildId, fromAlice, 'm2')])).toMatchObject([{ status: 'ok', content: { text: 'to carol' } }])
    expect(await alice.messages.decryptMessages([row(carol, general, guildId, fromCarol, 'm3')])).toMatchObject([{ status: 'ok', content: { text: 'to alice' }, sender: { membershipVerified: true } }])
  }, 120_000)

  it('a bundle for a group outside the scope: Takusen refuses it, and the redeemer drops it', async () => {
    const { ds, alice, bob, carol, guildId, general } = await world()
    const secret = ds.channel(guildId, [alice.userId, bob.userId])
    await act(ds, alice, guildId, { type: 5, channelId: secret, targetId: guildId, targetType: 'role', allow: 0, deny: AdminBits.VIEW_CHANNEL })
    const secretGid = ds.allocate('channel', { guildId, channelId: secret }, alice.deviceId)
    await ds.flush()
    ds.batch(secretGid, alice.deviceId)
    await ds.flush()
    const inv = await invite(ds, alice, guildId, [general])
    expect(inv.sent).toEqual({ groups: 1 })
    // bob reads the private channel. He signs a bundle with wrong keys up to the group epoch.
    const epoch = ds.groups.get(secretGid)!.epoch!
    const keys = Array.from({ length: epoch + 1 }, (_, e) => ({ epoch: e, secret: randomBytes(32) }))
    const blob = await forgeBundle(bob, inv.record, secretGid, keys)
    await expect(bob.transport.postInviteBundle(inv.inviteId, { groupId: secretGid, epoch, blob })).rejects.toMatchObject({ dsCode: 'ValidationError' })
    // A server that stores it all the same.
    ds.invites.get(inv.inviteId)!.bundles.push({ groupId: secretGid, epoch, blob, senderDevice: bob.deviceId, senderUser: bob.userId })
    ds.acceptInvite(inv.code, carol.userId)
    expect(await carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })).toEqual({ groups: 1, keys: 2 })
    expect(errors(carol)).toEqual(['invite bundle: the group is not in the scope of the invite'])
    expect(await carol.groups.exportHistoryKeys([fromB64url(secretGid)], 10)).toEqual([])
  }, 120_000)

  it('a record channel of another guild: the redeemer drops a bundle for a group whose descriptor names that guild', async () => {
    const { ds, alice, bob, carol, guildId, general } = await world()
    // bob and carol read the channel x of another guild. carol holds its group from epoch 1.
    const other = ds.guild([bob.userId, carol.userId])
    const x = ds.channel(other, [bob.userId, carol.userId])
    const xGid = ds.allocate('channel', { guildId: other, channelId: x }, bob.deviceId)
    await ds.flush()
    ds.batch(xGid, bob.deviceId)
    await ds.flush()
    expect(await carol.groups.currentEpoch(fromB64url(xGid))).toBe(1)
    // alice's admin state has no overwrite for x, so @everyone views it: the record names it. A
    // server that ignores the channel rule of §4 stores the record.
    const inv = await invite(ds, alice, guildId, [general, x])
    expect(inv.channelIds).toContain(x)
    expect(inv.sent).toEqual({ groups: 1 })
    // bob signs wrong keys for the epochs of x that carol does not hold. Takusen refuses the post.
    const blob = await forgeBundle(bob, inv.record, xGid, [
      { epoch: 0, secret: randomBytes(32) },
      { epoch: 1, secret: randomBytes(32) },
    ])
    await expect(bob.transport.postInviteBundle(inv.inviteId, { groupId: xGid, epoch: 1, blob })).rejects.toMatchObject({ dsCode: 'UnknownGroup' })
    // A server that stores it all the same: the group id passes, the descriptor of carol does not.
    ds.invites.get(inv.inviteId)!.bundles.push({ groupId: xGid, epoch: 1, blob, senderDevice: bob.deviceId, senderUser: bob.userId })
    ds.acceptInvite(inv.code, carol.userId)
    expect(await carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })).toEqual({ groups: 1, keys: 2 })
    expect(errors(carol)).toEqual(['invite bundle: the group is not in the scope of the invite'])
    expect(await carol.groups.epochSecret(fromB64url(xGid), 0)).toBeNull()
  }, 120_000)

  it('the redeemer gets the bundles again after it joins a scope group: the bundle of the Add fills the epochs that had none', async () => {
    const { ds, alice, bob, carol, guildId, general, gid } = await world()
    const inv = await invite(ds, alice, guildId, [general])
    // dave has no InviteService (an old client): his commit of epoch 3 sends no bundle.
    const dave = await addMember(ds, guildId, general, gid, alice)
    await dave.groups.resyncAll('fork')
    await ds.flush()
    ds.acceptInvite(inv.code, carol.userId)
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const refetches = () => timers.mock.calls.filter(([, ms]) => ms === INVITE_REFETCH_DELAY_MS).map(([fn]) => fn as () => void)
    const fetches = vi.spyOn(carol.transport, 'inviteBundles')
    try {
      expect(await carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })).toEqual({ groups: 1, keys: 3 })
      const redeemedAtMs = ds.id.now
      expect(refetches()).toHaveLength(1)
      expect(await carol.groups.epochSecret(fromB64url(gid), 3)).toBeNull()
      // bob commits the Add of carol (epoch 4). His bundle carries epochs 3 and 4.
      ds.id.now += 1000
      await carol.groups.ensureChannelGroup(general)
      await ds.flush()
      ds.batch(gid, bob.deviceId)
      await ds.flush()
      expect(await carol.groups.currentEpoch(fromB64url(gid))).toBe(4)
      expect(bundlesOf(ds, inv.inviteId).at(-1)).toEqual([bob.deviceId, 4])
      // The join moved the later fetch.
      expect(refetches()).toHaveLength(2)
      refetches().at(-1)!()
      await carol.invites!.idle()
      expect(fetches).toHaveBeenCalledTimes(2)
      expect(toB64url((await carol.groups.epochSecret(fromB64url(gid), 3))!)).toBe(toB64url((await bob.groups.epochSecret(fromB64url(gid), 3))!))
      expect(errors(carol)).toEqual([])
      expect((await carol.store.get('invites', inv.keyId))?.redeemedAtMs).toBe(redeemedAtMs)
      // After INVITE_BUNDLE_FETCH_WINDOW_MS, or after a revoke, no later fetch.
      ds.id.now = redeemedAtMs + INVITE_BUNDLE_FETCH_WINDOW_MS
      refetches()[0]!()
      await carol.invites!.idle()
      ds.id.now = redeemedAtMs
      ds.revokeInvite(inv.inviteId)
      await ds.flush()
      refetches()[0]!()
      await carol.invites!.idle()
      expect(fetches).toHaveBeenCalledTimes(2)
    } finally {
      timers.mockRestore()
      fetches.mockRestore()
    }
  }, 120_000)

  it('in a group that the redeemer holds, bundles give only the epochs below its current epoch', async () => {
    const { ds, alice, bob, carol, guildId, general, gid } = await world()
    const inv = await invite(ds, alice, guildId, [general])
    ds.acceptInvite(inv.code, carol.userId)
    await joinPublicSet(ds, carol, general, gid)
    expect(await carol.groups.currentEpoch(fromB64url(gid))).toBe(2)
    const real = async (e: number) => (await alice.groups.epochSecret(fromB64url(gid), e))!
    // Only a bundle of bob: the right secrets of epochs 0 and 1, wrong ones of 2 and 3, and an
    // epoch that a lying server raised.
    const keys = [{ epoch: 0, secret: await real(0) }, { epoch: 1, secret: await real(1) }, { epoch: 2, secret: randomBytes(32) }, { epoch: 3, secret: randomBytes(32) }]
    ds.invites.get(inv.inviteId)!.bundles = [{ groupId: gid, epoch: 3, blob: await forgeBundle(bob, inv.record, gid, keys), senderDevice: bob.deviceId, senderUser: bob.userId }]
    expect(await carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })).toEqual({ groups: 1, keys: 2 })
    expect(errors(carol)).toEqual([])
    for (const e of [0, 1, 2]) expect(toB64url((await carol.groups.epochSecret(fromB64url(gid), e))!)).toBe(toB64url(await real(e)))
    expect(await carol.groups.epochSecret(fromB64url(gid), 3)).toBeNull()
  }, 120_000)

  it('fails closed with the exact reason: creator, sender and record checks', async () => {
    const { ds, alice, bob, carol, guildId, general } = await world()
    const inv = await invite(ds, alice, guildId, [general])
    // bob's commit bundle of epoch 2.
    await bob.groups.resyncAll('fork')
    await ds.flush()
    ds.acceptInvite(inv.code, carol.userId)
    const redeem = (svc = carol.invites!) => svc.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })
    const revoked = (userId: string, deviceId: string): Partial<IdentityService> => ({
      chainContextFor: async (u, entering) => {
        const ctx = await carol.identity.chainContextFor(u, entering)
        return u === userId ? { ...ctx, revokedDeviceIds: new Set([...ctx.revokedDeviceIds, deviceId]) } : ctx
      },
    })
    const changed = (userId: string): Partial<IdentityService> => ({ trustOf: async (u) => (u === userId ? 'changed' : carol.identity.trustOf(u)) })

    // The client cache does not have the guild yet (no GUILD_CREATE): a retry code, not a record failure.
    ds.guilds.get(guildId)!.delete(carol.userId)
    await expect(redeem()).rejects.toMatchObject({ code: 'GroupPending' })
    ds.guilds.get(guildId)!.add(carol.userId)

    // The creator: a revoked device, a changed key, not a guild member.
    await expect(redeem(withIdentity(carol, revoked(alice.userId, alice.deviceId)))).rejects.toMatchObject({ code: 'InvalidChain', message: 'the invite record does not verify: the creator device is revoked' })
    await expect(redeem(withIdentity(carol, changed(alice.userId)))).rejects.toMatchObject({ code: 'InvalidChain', message: 'the invite record does not verify: the creator key changed' })
    ds.guilds.get(guildId)!.delete(alice.userId)
    await expect(redeem()).rejects.toMatchObject({ code: 'InvalidChain', message: 'the invite record does not verify: the creator is not a guild member' })
    ds.guilds.get(guildId)!.add(alice.userId)

    // The sender of a bundle: a revoked device (its certificate still verifies), a changed key, not
    // a guild member. Only that bundle goes: alice's epochs 0 and 1 stay.
    const cases: [ReturnType<typeof createInviteService>, string][] = [
      [withIdentity(carol, revoked(bob.userId, bob.deviceId)), 'invite bundle: the sender device is revoked'],
      [withIdentity(carol, changed(bob.userId)), 'invite bundle: the sender key changed'],
    ]
    for (const [svc, reason] of cases) {
      carol.events.length = 0
      expect(await redeem(svc)).toEqual({ groups: 1, keys: 2 })
      expect(errors(carol)).toEqual([reason])
    }
    carol.events.length = 0
    ds.guilds.get(guildId)!.delete(bob.userId)
    expect(await redeem()).toEqual({ groups: 1, keys: 2 })
    expect(errors(carol)).toEqual(['invite bundle: the sender is not a guild member'])
    ds.guilds.get(guildId)!.add(bob.userId)

    // A record with admin_chain_seq above the admin state of the guild.
    const seq = (await alice.identity.adminState(guildId))!.seq
    const seed = randomBytes(32)
    const k = deriveInviteKeys(seed)
    const self = alice.identity.self()
    const ahead = signInviteRecord(
      { guildId, hpkePublic: k.hpke.publicKey, signPublic: k.sign.publicKey, channelIds: [general], adminChainSeq: seq + 1, expiresAtMs: 0, maxUses: 0, creatorUserId: alice.userId, creatorDeviceId: self.deviceId },
      self.mlsSignatureKey.privateKey,
    )
    const next = ds.createInvite(guildId, toB64url(ahead))
    ds.acceptInvite(next.code, carol.userId)
    await expect(carol.invites!.redeemInvite({ code: next.code, linkSecret: toB64url(seed) })).rejects.toMatchObject({
      code: 'InvalidChain',
      message: 'the invite record does not verify: admin_chain_seq is ahead of the admin state',
    })
    await expect(alice.invites!.sendInviteBundles({ guildId, inviteId: next.inviteId, record: toB64url(ahead) })).rejects.toMatchObject({ code: 'InvalidChain' })
  }, 120_000)

  it('expiry: members stop at once; the redeemer still opens the bundles for INVITE_BUNDLE_FETCH_WINDOW_MS', async () => {
    const { ds, alice, bob, carol, guildId, general } = await world()
    const p = await alice.invites!.prepareHistoryInvite({ guildId, channelIds: [general], expiresAtMs: ds.id.now + 1000, maxUses: 0 })
    const { inviteId, code } = ds.createInvite(guildId, p.record)
    await alice.invites!.sendInviteBundles({ guildId, inviteId, record: p.record })
    ds.acceptInvite(code, carol.userId)
    ds.id.now += 1000 + 30 * 60_000
    await expect(bob.invites!.sendInviteBundles({ guildId, inviteId, record: p.record })).rejects.toMatchObject({ code: 'InvalidChain', message: 'the invite record does not verify: expired' })
    expect(await carol.invites!.redeemInvite({ code, linkSecret: p.linkSecret })).toEqual({ groups: 1, keys: 2 })
    ds.id.now += 30 * 60_000
    await expect(carol.invites!.redeemInvite({ code, linkSecret: p.linkSecret })).rejects.toMatchObject({ code: 'InvalidChain', message: 'the invite record does not verify: expired' })
  }, 120_000)

  it('wipes the seed of a redeemer without a later commit: by its timer, and at the next start', async () => {
    const { ds, alice, carol, guildId, general } = await world()
    const permanent = async () => {
      const p = await alice.invites!.prepareHistoryInvite({ guildId, channelIds: [general], expiresAtMs: 0, maxUses: 0 })
      const { inviteId, code } = ds.createInvite(guildId, p.record)
      await alice.invites!.sendInviteBundles({ guildId, inviteId, record: p.record })
      ds.acceptInvite(code, carol.userId)
      return { ...p, code, keyId: toB64url(decodeInviteRecord(decodeSignedInviteRecord(fromB64url(p.record)).record).signPublic) }
    }
    const first = await permanent()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    await carol.invites!.redeemInvite({ code: first.code, linkSecret: first.linkSecret })
    await carol.invites!.idle()
    const call = timers.mock.calls.find(([, ms]) => ms === DAY + 1)
    timers.mockRestore()
    expect(call).toBeDefined()
    ds.id.now += DAY
    expect((await carol.store.get('invites', first.keyId))?.seed).not.toBeNull()
    ds.id.now += 1
    ;(call![0] as () => void)()
    await carol.invites!.idle()
    expect(await carol.store.get('invites', first.keyId)).toMatchObject({ role: 'redeemed', seed: null })

    const second = await permanent()
    await carol.invites!.redeemInvite({ code: second.code, linkSecret: second.linkSecret })
    ds.id.now += DAY + 1
    const restarted = createInviteService(carol.ctx, carol.identity, carol.groups, clientPermissions)
    await restarted.idle()
    expect(await carol.store.get('invites', second.keyId)).toMatchObject({ role: 'redeemed', seed: null })
  }, 120_000)

  it('wipes the redeemer seed after INVITE_AUTH_WINDOW_MS and drops expired rows', async () => {
    const { ds, alice, carol, guildId, general, gid } = await world()
    const inv = await invite(ds, alice, guildId, [general])
    ds.acceptInvite(inv.code, carol.userId)
    await carol.invites!.redeemInvite({ code: inv.code, linkSecret: inv.linkSecret })
    // carol joins public_set: her own external commit reads the record list (and prunes).
    ds.id.now += DAY / 2
    await joinPublicSet(ds, carol, general, gid)
    expect((await carol.store.get('invites', inv.keyId))?.seed).not.toBeNull()
    expect(bundlesOf(ds, inv.inviteId).at(-1)).toEqual([carol.deviceId, 2])
    ds.id.now += DAY / 2 + 1
    await carol.groups.resyncAll('fork')
    await ds.flush()
    expect(await carol.store.get('invites', inv.keyId)).toBeUndefined()
  }, 120_000)
})
