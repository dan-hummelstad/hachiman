import { describe, expect, it } from 'vitest'

import type { FrameKeyMessage } from '../api'
import { SFRAME_OLD_EPOCH_RETENTION_MS, SFRAME_REPLAY_WINDOW, SFRAME_SCREEN_AUDIO_LEAF_OFFSET } from '../constants'
import { sframe } from './sframe'
import { FrameKeyRing, ReplayWindow } from './transform'

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002'
const CAROL = 'cccccccc-0000-4000-8000-000000000003'
const random = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n))

const leaves = [
  { leafIndex: 0, userId: ALICE },
  { leafIndex: 1, userId: BOB },
  { leafIndex: 2, userId: CAROL },
]

function epochMsg(epoch: number, secret: Uint8Array, selfLeaf: number): FrameKeyMessage {
  return { type: 'epoch', epoch, secret: new Uint8Array(secret), selfLeaf, leaves }
}

/** Alice sends; Bob receives. Both hold the same epochs. */
function pair(epochs: { epoch: number; secret: Uint8Array }[], activate: number | null, now = 0) {
  const alice = new FrameKeyRing()
  const bob = new FrameKeyRing()
  for (const e of epochs) {
    alice.handle(epochMsg(e.epoch, e.secret, 0), now)
    bob.handle(epochMsg(e.epoch, e.secret, 1), now)
  }
  if (activate !== null) {
    alice.handle({ type: 'activate', epoch: activate }, now)
    bob.handle({ type: 'activate', epoch: activate }, now)
  }
  return { alice, bob }
}

const audio = { track: 'audio', codec: 'opus' } as const
const video = { track: 'video', codec: 'vp8' } as const
const fromAlice = { ...audio, userId: ALICE }

async function sent(ring: FrameKeyRing, frame: Uint8Array, opts: { track: 'audio' | 'video'; codec: 'opus' | 'vp8' } = audio): Promise<Uint8Array> {
  const r = await ring.encrypt(frame, opts)
  if (!('frame' in r)) throw new Error(`dropped: ${r.drop}`)
  return r.frame
}

function header(frame: Uint8Array, codec: 'opus' | 'vp8' = 'opus') {
  return sframe.decodeHeader(frame, sframe.clearPrefixLength(codec, frame))
}

describe('ReplayWindow', () => {
  it('accepts each counter once, out of order inside the window, and nothing older', () => {
    const w = new ReplayWindow()
    expect(w.accept(5n)).toBe(true)
    expect(w.accept(5n)).toBe(false)
    expect(w.accept(3n)).toBe(true)
    expect(w.accept(3n)).toBe(false)
    expect(w.accept(4n)).toBe(true)
    const far = 5n + BigInt(SFRAME_REPLAY_WINDOW)
    expect(w.accept(far)).toBe(true)
    expect(w.seen(5n)).toBe(true)
    // 6 is the oldest counter inside the window, 5 is outside.
    expect(w.accept(6n)).toBe(true)
    expect(w.accept(6n)).toBe(false)
    expect(w.accept(5n)).toBe(false)
    expect(w.accept(far - 1n)).toBe(true)
    expect(w.accept(far + 10_000n)).toBe(true)
    expect(w.accept(far + 9_999n)).toBe(true)
    expect(w.accept(far)).toBe(false)
  })
})

describe('FrameKeyRing', () => {
  const s1 = random(32)
  const s2 = random(32)

  it('drops every frame before a key is active (no plaintext passthrough)', async () => {
    const ring = new FrameKeyRing()
    expect(await ring.encrypt(random(20), audio)).toEqual({ drop: 'unknownKey' })
    // A well-formed header (KID 0, CTR 0) and no key.
    expect(await ring.decrypt(Uint8Array.of(0x00, ...random(20)), fromAlice, 0)).toEqual({ drop: 'unknownKey' })
    ring.handle(epochMsg(0, s1, 0), 0)
    expect(await ring.encrypt(random(20), audio)).toEqual({ drop: 'unknownKey' })
    expect(ring.snapshot().dropped.unknownKey).toBe(3)
  })

  it('round-trips audio and video with separate KIDs and counters from 0', async () => {
    const { alice, bob } = pair([{ epoch: 0, secret: s1 }], 0)
    const a1 = random(60)
    const a2 = random(60)
    const v1 = Uint8Array.from([0x10, ...random(300)])
    const v2 = Uint8Array.from([0x01, ...random(100)])
    const wa1 = await sent(alice, a1)
    const wa2 = await sent(alice, a2)
    const wv1 = await sent(alice, v1, video)
    const wv2 = await sent(alice, v2, video)
    expect(header(wa1)).toMatchObject({ kid: sframe.packKid(0, 0, 0), ctr: 0n })
    expect(header(wa2)).toMatchObject({ kid: sframe.packKid(0, 0, 0), ctr: 1n })
    expect(header(wv1, 'vp8')).toMatchObject({ kid: sframe.packKid(0, 1, 0), ctr: 0n })
    expect(header(wv2, 'vp8')).toMatchObject({ kid: sframe.packKid(0, 1, 0), ctr: 1n })
    expect(await bob.decrypt(wa1, fromAlice, 0)).toEqual({ frame: a1 })
    expect(await bob.decrypt(wa2, fromAlice, 0)).toEqual({ frame: a2 })
    expect(await bob.decrypt(wv1, { ...video, userId: ALICE }, 0)).toEqual({ frame: v1 })
    expect(await bob.decrypt(wv2, { ...video, userId: ALICE }, 0)).toEqual({ frame: v2 })
    expect(alice.snapshot()).toMatchObject({ encrypted: 4 })
    expect(bob.snapshot()).toMatchObject({ decrypted: 4, dropped: { unknownKey: 0, authFailed: 0, replay: 0, wrongSender: 0 } })
  })

  it('drops a wrong sender leaf, a wrong track bit and the own leaf', async () => {
    const { alice, bob } = pair([{ epoch: 0, secret: s1 }], 0)
    const w = await sent(alice, random(30))
    // The receiver of Carol's track gets a frame with Alice's leaf.
    expect(await bob.decrypt(w, { ...audio, userId: CAROL }, 0)).toEqual({ drop: 'wrongSender' })
    // An audio KID on the video receiver.
    const wv = await sent(alice, Uint8Array.from([0x01, ...random(30)]), video)
    expect(await bob.decrypt(wv, { track: 'audio', codec: 'vp8', userId: ALICE }, 0)).toEqual({ drop: 'wrongSender' })
    expect(await bob.decrypt(w, { track: 'video', codec: 'opus', userId: ALICE }, 0)).toEqual({ drop: 'wrongSender' })
    // Bob's own leaf, played back by the SFU as if from another device of the same user.
    const bobSends = new FrameKeyRing()
    bobSends.handle(epochMsg(0, s1, 1), 0)
    bobSends.handle({ type: 'activate', epoch: 0 }, 0)
    expect(await bob.decrypt(await sent(bobSends, random(30)), { ...audio, userId: BOB }, 0)).toEqual({ drop: 'wrongSender' })
    expect(bob.snapshot().dropped.wrongSender).toBe(4)
  })

  it('keeps screen audio apart from the mic, also with a ring each (no shared key or counter)', async () => {
    const screenAudio = { track: 'screen-audio', codec: 'opus' } as const
    // The mic and the screen audio sender transforms each have their own port, so their own ring.
    const { alice: mic, bob } = pair([{ epoch: 0, secret: s1 }], 0)
    const { alice: share } = pair([{ epoch: 0, secret: s1 }], 0)
    const plain = random(40)
    const wm = await sent(mic, plain)
    const r = await share.encrypt(plain, screenAudio)
    if (!('frame' in r)) throw new Error(r.drop)
    const ws = r.frame
    const hs = header(ws)
    expect(header(wm)).toMatchObject({ kid: sframe.packKid(0, 0, 0), ctr: 0n })
    expect(hs).toMatchObject({ kid: sframe.packKid(SFRAME_SCREEN_AUDIO_LEAF_OFFSET, 0, 0), ctr: 0n })
    // Same plaintext and CTR 0, different keys: different ciphertexts.
    expect(ws.subarray(ws.length - 16)).not.toEqual(wm.subarray(wm.length - 16))
    expect(await bob.decrypt(ws, { ...screenAudio, userId: ALICE }, 0)).toEqual({ frame: plain })
    expect(await bob.decrypt(wm, fromAlice, 0)).toEqual({ frame: plain })
    // The SFU cannot swap the two audio streams.
    const ws2 = await share.encrypt(random(40), screenAudio)
    const wm2 = await sent(mic, random(40))
    if (!('frame' in ws2)) throw new Error(ws2.drop)
    expect(await bob.decrypt(ws2.frame, fromAlice, 0)).toEqual({ drop: 'wrongSender' })
    expect(await bob.decrypt(wm2, { ...screenAudio, userId: ALICE }, 0)).toEqual({ drop: 'wrongSender' })
    // The screen audio leaf maps back to the real leaf for the sender check.
    expect(await bob.decrypt(ws2.frame, { ...screenAudio, userId: CAROL }, 0)).toEqual({ drop: 'wrongSender' })
  })

  it('drops a replay and a tampered frame', async () => {
    const { alice, bob } = pair([{ epoch: 0, secret: s1 }], 0)
    const w = await sent(alice, random(30))
    expect('frame' in (await bob.decrypt(w, fromAlice, 0))).toBe(true)
    expect(await bob.decrypt(w, fromAlice, 0)).toEqual({ drop: 'replay' })
    const w2 = await sent(alice, random(30))
    const bad = w2.slice()
    bad[bad.length - 1]! ^= 1
    expect(await bob.decrypt(bad, fromAlice, 0)).toEqual({ drop: 'authFailed' })
    // A failed tag does not mark the counter: the real frame still decrypts.
    expect('frame' in (await bob.decrypt(w2, fromAlice, 0))).toBe(true)
    expect(await bob.decrypt(Uint8Array.of(0xff), fromAlice, 0)).toEqual({ drop: 'authFailed' })
  })

  it('keeps the previous epoch for 10 s after activate, then drops it', async () => {
    const { alice, bob } = pair([{ epoch: 4, secret: s1 }], 4)
    const old1 = await sent(alice, random(30))
    const old2 = await sent(alice, random(30))
    // The next epoch: installed, then activated at t = 1000.
    alice.handle(epochMsg(5, s2, 0), 1000)
    bob.handle(epochMsg(5, s2, 1), 1000)
    alice.handle({ type: 'activate', epoch: 5 }, 1000)
    const fresh = await sent(alice, random(30))
    expect(header(fresh)).toMatchObject({ kid: sframe.packKid(0, 0, 5), ctr: 0n })
    // Bob gets the new epoch before his own activate (peers switch at slightly different times).
    expect('frame' in (await bob.decrypt(fresh, fromAlice, 1000))).toBe(true)
    bob.handle({ type: 'activate', epoch: 5 }, 1000)
    expect('frame' in (await bob.decrypt(old1, fromAlice, 1000 + SFRAME_OLD_EPOCH_RETENTION_MS - 1))).toBe(true)
    expect(await bob.decrypt(old2, fromAlice, 1000 + SFRAME_OLD_EPOCH_RETENTION_MS)).toEqual({ drop: 'unknownKey' })
  })

  it('never resets a counter under a live key', async () => {
    const { alice } = pair([{ epoch: 0, secret: s1 }], 0)
    await sent(alice, random(10))
    await sent(alice, random(10))
    // The same epoch key again (a second port attach): the counter goes on.
    alice.handle(epochMsg(0, s1, 0), 0)
    alice.handle({ type: 'activate', epoch: 0 }, 0)
    expect(header(await sent(alice, random(10))).ctr).toBe(2n)
    // An older epoch cannot come back as the send epoch.
    alice.handle(epochMsg(1, s2, 0), 0)
    alice.handle({ type: 'activate', epoch: 1 }, 0)
    alice.handle({ type: 'activate', epoch: 0 }, 0)
    expect(header(await sent(alice, random(10)))).toMatchObject({ kid: sframe.packKid(0, 0, 1), ctr: 0n })
    // Concurrent frames get distinct counters.
    const ws = await Promise.all([0, 1, 2, 3].map(() => sent(alice, random(10))))
    expect(new Set(ws.map((w) => header(w).ctr)).size).toBe(4)
  })

  it('retire and close stop the senders', async () => {
    const { alice, bob } = pair([{ epoch: 0, secret: s1 }], 0)
    const w = await sent(alice, random(10))
    alice.handle({ type: 'retire', epoch: 0 }, 0)
    expect(await alice.encrypt(random(10), audio)).toEqual({ drop: 'unknownKey' })
    // A room reset: a new group starts at epoch 0 with a new secret and counters from 0.
    alice.handle(epochMsg(0, s2, 0), 0)
    alice.handle({ type: 'activate', epoch: 0 }, 0)
    expect(header(await sent(alice, random(10))).ctr).toBe(0n)
    bob.handle({ type: 'close' }, 0)
    expect(bob.isClosed).toBe(true)
    expect(await bob.decrypt(w, fromAlice, 0)).toEqual({ drop: 'unknownKey' })
  })
})
