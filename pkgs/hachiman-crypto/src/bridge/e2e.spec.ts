import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CryptoClient, EncryptedMessage, EncryptMessageOutput, MessageContent } from '../api'
import { admin } from '../admin/index'
import { FakeMlsDs, type Client } from '../mls/fake-ds'
import { inProcessClient, LocksShim, wrapKey } from './test-harness'

interface Person {
  userId: string
  deviceId: string
  client: CryptoClient
}

/** A device behind the real bridge, RPC, engine and IndexedDB store, wired to the fake DS. */
async function person(ds: FakeMlsDs): Promise<Person> {
  const userId = ds.uuid()
  const { client, engine } = inProcessClient(ds.transport(userId))
  await client.init({ userId, wrapKey: await wrapKey(), platform: 'electron', clientVersion: '1.0.0', deviceName: 'Desktop', origin: 'https://takusen.test' })
  const { status } = await client.setupFirstDevice()
  const deviceId = status.deviceId!
  // Gateway events of both fakes go to the client, as ui-core forwards them.
  ds.id.subscribe(deviceId, (e) => client.onGatewayEvent(e))
  const route = { onGatewayEvent: (e: Parameters<CryptoClient['onGatewayEvent']>[0]) => client.onGatewayEvent(e), idle: () => engine.idle() }
  ds.clients.set(deviceId, { online: true, groups: route, invites: route } as unknown as Client)
  return { userId, deviceId, client }
}

const text = (t: string, attachments: MessageContent['attachments'] = []): Omit<MessageContent, 'sentAtMs'> => ({ text: t, mentions: [], attachments, replyTo: null })

function row(ds: FakeMlsDs, author: Person, channelId: string, out: EncryptMessageOutput, attachments: EncryptedMessage['attachments'] = []): EncryptedMessage {
  return {
    id: ds.uuid(),
    channelId,
    guildId: null,
    authorId: author.userId,
    senderDevice: author.deviceId,
    groupId: out.groupId,
    epoch: out.epoch,
    clientMsgId: out.clientMsgId,
    envelope: out.envelope,
    attachments,
    createdAt: new Date().toISOString(),
    editedAt: null,
  }
}

describe('two CryptoClients end to end', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { locks: new LocksShim() })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sets up, forms a DM by batch assign, and sends a message, an edit and an attachment', async () => {
    const ds = await new FakeMlsDs().init()
    const alice = await person(ds)
    const bob = await person(ds)
    await ds.flush()

    // Takusen allocates the DM group and assigns the create, then the batch with bob's Add.
    const channelId = ds.channel(null, [alice.userId, bob.userId])
    const gid = ds.allocate('dm', { guildId: null, channelId }, alice.deviceId)
    await ds.flush()
    ds.batch(gid, alice.deviceId)
    await ds.flush()
    expect(ds.log.filter((l) => l.startsWith('Invalid') || l.startsWith('Illegal'))).toEqual([])
    expect((await bob.client.ensureChannelGroup(channelId)).member).toBe(true)
    expect(await bob.client.getEpochCode(gid)).toBe(await alice.client.getEpochCode(gid))

    // A message.
    const sent = await alice.client.encryptMessage({ channelId, kind: 'message', editOf: null, content: text('hello bob') })
    expect(sent.groupId).toBe(gid)
    const m = row(ds, alice, channelId, sent)
    const [r] = await bob.client.decryptMessages([m])
    expect(r).toMatchObject({ status: 'ok', kind: 'message', editOf: null, content: { text: 'hello bob' }, sender: { userId: alice.userId, deviceId: alice.deviceId, membershipVerified: true } })
    // The sender reads its own message too.
    expect((await alice.client.decryptMessages([m]))[0]?.status).toBe('ok')

    // An edit keeps the client_msg_id and the message id.
    const edit = await alice.client.encryptMessage({ channelId, kind: 'edit', editOf: sent.clientMsgId, content: text('hello bob, edited') })
    expect(edit.clientMsgId).toBe(sent.clientMsgId)
    const [er] = await bob.client.decryptMessages([{ ...row(ds, alice, channelId, edit), id: m.id, editedAt: new Date().toISOString() }])
    expect(er).toMatchObject({ status: 'ok', kind: 'edit', editOf: sent.clientMsgId, content: { text: 'hello bob, edited' } })
    // A replayed envelope under another message id is refused.
    expect((await bob.client.decryptMessages([{ ...m, id: ds.uuid() }]))[0]).toMatchObject({ status: 'failed', reason: 'replay' })

    // An attachment: encrypt, "upload", send the pointer, decrypt on the other side.
    // Three 64 KiB segments.
    const bytes = new Uint8Array(150_000)
    for (let i = 0; i < bytes.length; i += 65_536) crypto.getRandomValues(bytes.subarray(i, i + 65_536))
    const enc = await alice.client.encryptAttachment({ file: new Blob([bytes]), name: 'noise.bin', mime: 'application/octet-stream', width: null, height: null, durationMs: null, blurhash: null, thumbnail: null })
    expect(enc.blob.size).toBe(enc.draft.blobSize)
    const uploadId = ds.uuid()
    const pointer = { ...enc.draft, uploadId, thumbnail: null }
    const withFile = await alice.client.encryptMessage({ channelId, kind: 'message', editOf: null, content: text('a file', [pointer]) })
    const [ar] = await bob.client.decryptMessages([row(ds, alice, channelId, withFile, [{ id: uploadId, size: enc.blob.size }])])
    if (ar?.status !== 'ok' || ar.kind !== 'message') throw new Error(`attachment message: ${JSON.stringify(ar)}`)
    const got = ar.content.attachments[0]!
    expect(got).toMatchObject({ uploadId, name: 'noise.bin', size: bytes.length })
    const plain = await bob.client.decryptAttachment(got, enc.blob)
    expect(new Uint8Array(await plain.arrayBuffer())).toEqual(bytes)
    // A blob that is not the one the pointer names does not decrypt.
    await expect(bob.client.decryptAttachment(got, new Blob([enc.blob.slice(0, enc.blob.size - 1), new Uint8Array(1)]))).rejects.toMatchObject({ code: 'Malformed' })

    alice.client.dispose()
    bob.client.dispose()
  }, 120_000)

  it('makes, sends, redeems and revokes an invite with history through the Worker API', async () => {
    const ds = await new FakeMlsDs().init()
    const alice = await person(ds)
    const bob = await person(ds)
    await ds.flush()
    const guildId = ds.guild([alice.userId])
    const general = ds.channel(guildId, [alice.userId])
    const genesis = await alice.client.signAdminAction(guildId, 0, admin.encodePayload({ type: 0, ownerId: alice.userId }))
    ds.id.storeAdminAction(guildId, genesis.header)
    const gid = ds.allocate('public_set', { guildId, channelId: null }, alice.deviceId)
    await ds.flush()
    const sent = await alice.client.encryptMessage({ channelId: general, kind: 'message', editOf: null, content: text('before bob') })

    const p = await alice.client.prepareHistoryInvite({ guildId, channelIds: [general], expiresAtMs: Date.now() + 86_400_000, maxUses: 0 })
    const { inviteId, code } = ds.createInvite(guildId, p.record)
    expect(await alice.client.sendInviteBundles({ guildId, inviteId, record: p.record })).toEqual({ groups: 1 })
    ds.acceptInvite(code, bob.userId)
    expect(await bob.client.redeemInvite({ code, linkSecret: p.linkSecret })).toEqual({ groups: 1, keys: 1 })
    const [r] = await bob.client.decryptMessages([{ ...row(ds, alice, general, sent), guildId }])
    expect(r).toMatchObject({ status: 'ok', content: { text: 'before bob' }, sender: { membershipVerified: false } })

    // INVITE_DELETE reaches the invite service: a server that lists the invite again gets no bundle.
    ds.revokeInvite(inviteId)
    await ds.flush()
    ds.invites.get(inviteId)!.revoked = false
    await bob.client.ensureChannelGroup(general)
    await ds.flush()
    ds.batch(gid, alice.deviceId)
    await ds.flush()
    expect(ds.groups.get(gid)!.epoch).toBe(1)
    expect(ds.invites.get(inviteId)!.bundles).toEqual([])

    alice.client.dispose()
    bob.client.dispose()
  }, 120_000)
})
