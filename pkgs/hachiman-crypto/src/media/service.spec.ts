import { describe, expect, it } from 'vitest'

import type { FrameKeyMessage, VoiceE2eeClientOp } from '../api'
import { fromB64url, toB64url } from '../codec'
import { FakeMlsDs, type Client } from '../mls/fake-ds'
import { keyPackageIdentity } from '../mls/index'
import { FakeMedia, type VoiceClient } from './fake-media'
import { commitSenderLeaf, createVoiceService, type VoiceServiceExt } from './service'
import { FrameKeyRing } from './transform'

interface Member {
  client: Client
  voice: VoiceServiceExt
  port: { messages: FrameKeyMessage[] }
  call: VoiceClient
}

/** A MessagePort stand-in: keeps a structured clone of every message (the service zeroes its copy). */
function fakePort(): MessagePort & { messages: FrameKeyMessage[] } {
  const messages: FrameKeyMessage[] = []
  return { messages, postMessage: (m: FrameKeyMessage) => void messages.push(structuredClone(m)), close: () => undefined } as unknown as MessagePort & { messages: FrameKeyMessage[] }
}

async function room(names: string[]) {
  const ds = await new FakeMlsDs().init()
  const clients: Record<string, Client> = {}
  for (const n of names) clients[n] = await ds.client(ds.uuid())
  await ds.flush()
  const guildId = ds.uuid()
  const media = new FakeMedia(ds.uuid(), guildId)
  const members: Record<string, Member> = {}
  const join = async (name: string): Promise<Member> => {
    const client = clients[name]!
    const voice = createVoiceService(client.ctx, client.identity)
    const call = await media.join(name, client.userId, client.deviceId, voice)
    const port = fakePort()
    await voice.voiceAttachTransform(call.handle, port)
    members[name] = { client, voice, port, call }
    await media.flush()
    return members[name]
  }
  return { ds, clients, media, members, join, guildId }
}

async function epochCodes(ms: Member[]): Promise<(string | null)[]> {
  return Promise.all(ms.map((m) => m.voice.voiceEpochCode(m.call.handle)))
}

async function rosterUsers(m: Member): Promise<string[]> {
  return (await m.voice.voiceRoster(m.call.handle)).map((e) => e.userId).sort()
}

function lastActivated(m: Member): number | null {
  const a = m.port.messages.filter((x) => x.type === 'activate')
  return a.length === 0 ? null : (a.at(-1) as { epoch: number }).epoch
}

/** A ring fed with every FrameKeyMessage the member's port got. */
function ringOf(m: Member): FrameKeyRing {
  const r = new FrameKeyRing()
  for (const msg of m.port.messages) r.handle(msg, 0)
  return r
}

function ops(media: FakeMedia, from: string, op: VoiceE2eeClientOp['op']): VoiceE2eeClientOp[] {
  return media.log.filter((l) => l.from === from && l.op.op === op).map((l) => l.op)
}

describe('VoiceService', () => {
  it('creates, adds by Welcome + tree, fails over the committer and removes departed leaves', async () => {
    const { media, join, clients } = await room(['alice', 'bob', 'carol', 'dave'])
    const alice = await join('alice')
    const aliceSid = media.sidOf(alice.call)
    expect(media.epoch).toBe(0)
    expect(ops(media, 'alice', 'e2ee_ready')[0]).toEqual({ op: 'e2ee_ready', d: { transitionId: null, epoch: 0, leafIndex: 0 } })
    expect(lastActivated(alice)).toBe(0)

    const bob = await join('bob')
    const carol = await join('carol')
    expect(media.epoch).toBe(2)
    expect(media.closes).toEqual([])
    const codes = await epochCodes([alice, bob, carol])
    expect(codes[0]).toMatch(/^\d{30}$/)
    expect(new Set(codes).size).toBe(1)
    for (const m of [alice, bob, carol]) {
      expect(await rosterUsers(m)).toEqual([clients['alice']!.userId, clients['bob']!.userId, clients['carol']!.userId].sort())
      expect(lastActivated(m)).toBe(2)
    }
    // The commit with a Welcome is followed by the tree of epoch + 1.
    const aliceOps = media.log.filter((l) => l.from === 'alice').map((l) => l.op.op)
    expect(aliceOps.indexOf('e2ee_ratchet_tree')).toBe(aliceOps.indexOf('e2ee_commit') + 1)

    // Media frames flow between the members with the epoch keys.
    const frame = globalThis.crypto.getRandomValues(new Uint8Array(80))
    const sent = await ringOf(alice).encrypt(frame, { track: 'audio', codec: 'opus' })
    expect('frame' in sent && (await ringOf(carol).decrypt(sent.frame, { track: 'audio', codec: 'opus', userId: clients['alice']!.userId }, 0))).toEqual({ frame })

    // The committer leaves: bob (the next lowest leaf) takes over and removes alice's leaf.
    await media.leave(alice.call)
    expect(media.epoch).toBe(3)
    expect(ops(media, 'bob', 'e2ee_commit').at(-1)).toMatchObject({ d: { epoch: 2, welcome: null, added: [], removed: [aliceSid] } })
    expect(new Set(await epochCodes([bob, carol])).size).toBe(1)
    expect(await rosterUsers(bob)).toEqual([clients['bob']!.userId, clients['carol']!.userId].sort())
    expect(await rosterUsers(carol)).toEqual(await rosterUsers(bob))
    expect(media.departed).toEqual([])

    // A joiner, then a departure.
    const dave = await join('dave')
    expect(new Set(await epochCodes([bob, carol, dave])).size).toBe(1)
    const carolSid = media.sidOf(carol.call)
    await media.leave(carol.call)
    // dave took alice's free leaf 0, so dave is the committer now.
    expect(media.committer?.client.name).toBe('dave')
    expect(ops(media, 'dave', 'e2ee_commit').at(-1)).toMatchObject({ d: { added: [], removed: [carolSid] } })
    expect(new Set(await epochCodes([bob, dave])).size).toBe(1)
    expect(await rosterUsers(dave)).toEqual([clients['bob']!.userId, clients['dave']!.userId].sort())
    expect(media.epoch).toBe(5)
    expect(media.departed).toEqual([])
    expect(media.closes).toEqual([])
  }, 120_000)

  it('lets the first of two concurrent commits win; the loser applies the winner', async () => {
    const { media, join } = await room(['alice', 'bob', 'carol'])
    const alice = await join('alice')
    const bob = await join('bob')
    const carol = await join('carol')
    // bob is told that he is the committer too, so both commit the Remove of carol.
    media.interceptServer = (to, op) => (to.client.name === 'bob' && op.op === 'e2ee_roster' ? { op: 'e2ee_roster', d: { ...op.d, committer: to.sid } } : op)
    await media.leave(carol.call)
    // alice: Add bob, Add carol, Remove carol (the winner).
    expect(ops(media, 'alice', 'e2ee_commit')).toHaveLength(3)
    expect(ops(media, 'bob', 'e2ee_commit')).toHaveLength(1)
    expect(media.epoch).toBe(3)
    expect(media.closes).toEqual([])
    expect(new Set(await epochCodes([alice, bob])).size).toBe(1)
    expect(lastActivated(bob)).toBe(3)
  }, 120_000)

  it('moves the committer role after the 5 s timer', async () => {
    const { media, join } = await room(['alice', 'bob', 'carol'])
    const alice = await join('alice')
    const bob = await join('bob')
    // alice gets carol's key package but sends no commit.
    media.interceptClient = (from, op) => (from.client.name === 'alice' && (op.op === 'e2ee_commit' || op.op === 'e2ee_ratchet_tree') ? null : op)
    const carol = await join('carol')
    expect(media.epoch).toBe(1)
    media.interceptClient = null
    await media.failover()
    expect(media.committer?.client.name).toBe('bob')
    expect(media.epoch).toBe(2)
    expect(ops(media, 'bob', 'e2ee_commit')).toHaveLength(1)
    expect(new Set(await epochCodes([alice, bob, carol])).size).toBe(1)
  }, 120_000)

  it('reports a garbage commit with committerLeaf; the media node evicts the committer and the room goes on', async () => {
    const { media, join, clients } = await room(['alice', 'bob', 'carol', 'dave'])
    const alice = await join('alice')
    const bob = await join('bob')
    const carol = await join('carol')
    expect(media.epoch).toBe(2)
    const before = await epochCodes([bob, carol])
    const aliceSid = media.sidOf(alice.call)
    // alice's next commit keeps a valid media header but has a garbage body.
    media.interceptClient = (from, op) => {
      if (from.client.name !== 'alice' || op.op !== 'e2ee_commit') return op
      const real = fromB64url(op.d.commit)
      const header = real.subarray(0, 4 + 1 + 22 + 8 + 1 + 4)
      const garbage = new Uint8Array([...header, ...globalThis.crypto.getRandomValues(new Uint8Array(200))])
      expect(commitSenderLeaf(garbage)).toBe(0)
      return { op: 'e2ee_commit', d: { ...op.d, commit: toB64url(garbage) } }
    }
    const dave = await join('dave')
    media.interceptClient = null
    await media.flush()
    for (const name of ['bob', 'carol']) {
      const inv = ops(media, name, 'e2ee_invalid')
      expect(inv).toHaveLength(1)
      expect(inv[0]).toMatchObject({ op: 'e2ee_invalid', d: { transitionId: 3, committerLeaf: 0 } })
    }
    // alice itself rejects the commit that is not its own: the media node closes it either way.
    expect(media.closes).toHaveLength(1)
    expect(media.closes[0]!.sid).toBe(aliceSid)
    // bob becomes the committer: Remove alice (the roster comes first), then Add dave (its key
    // package comes next). Everyone ends in one epoch.
    const bobCommits = ops(media, 'bob', 'e2ee_commit').map((o) => o.d as { epoch: number; added: string[]; removed: string[] })
    expect(bobCommits.map((d) => [d.epoch, d.added, d.removed])).toEqual([
      [2, [], [aliceSid]],
      [3, [media.sidOf(dave.call)], []],
    ])
    expect(media.epoch).toBe(4)
    const after = await epochCodes([bob, carol, dave])
    expect(new Set(after).size).toBe(1)
    expect(after[0]).not.toBe(before[0])
    expect(await rosterUsers(dave)).toEqual([clients['bob']!.userId, clients['carol']!.userId, clients['dave']!.userId].sort())
  }, 120_000)

  it('adds only a key package whose credential equals the roster entry', async () => {
    const { media, join, clients } = await room(['alice', 'bob', 'mallory'])
    const alice = await join('alice')
    // The media node relays mallory's key package under bob's roster entry.
    let swapped = false
    media.interceptServer = (_to, op) => {
      if (op.op !== 'e2ee_key_package' || swapped) return op
      swapped = true
      return { op: 'e2ee_key_package', d: { ...op.d, keyPackage: malloryKp } }
    }
    const mallory = createVoiceService(clients['mallory']!.ctx, clients['mallory']!.identity)
    const malloryKp = (await mallory.voiceStart({ channelId: media.channelId })).keyPackage
    expect(keyPackageIdentity(fromB64url(malloryKp)).userId).toBe(clients['mallory']!.userId)
    await join('bob')
    expect(swapped).toBe(true)
    expect(ops(media, 'alice', 'e2ee_commit')).toHaveLength(0)
    expect(media.epoch).toBe(0)
    expect(await rosterUsers(alice)).toEqual([clients['alice']!.userId])
  }, 120_000)

  it('keeps the previous epoch keys until execute and stops cleanly', async () => {
    const { media, join } = await room(['alice', 'bob'])
    const alice = await join('alice')
    const bob = await join('bob')
    const epochs = alice.port.messages.filter((m) => m.type === 'epoch').map((m) => (m as { epoch: number }).epoch)
    expect(epochs).toEqual([0, 1])
    // Prepared epoch 1 keys arrive before the activate of epoch 1.
    const types = alice.port.messages.map((m) => `${m.type}:${(m as { epoch?: number }).epoch ?? ''}`)
    expect(types.indexOf('epoch:1')).toBeLessThan(types.indexOf('activate:1'))
    expect(bob.port.messages.map((m) => m.type)).toEqual(['epoch', 'activate'])
    await bob.voice.voiceStop(bob.call.handle)
    expect(bob.port.messages.at(-1)).toEqual({ type: 'close' })
    await expect(bob.voice.voiceRoster(bob.call.handle)).rejects.toThrow()
    expect(media.epoch).toBe(1)
  }, 120_000)
})
