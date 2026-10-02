/**
 * Fuzz and property tests of the SFrame key ring (§12.10.2). Invariants:
 *  - (key, KID, CTR) never repeats on the sender, whatever order the key messages come in;
 *  - a receiver never returns a frame that the sender did not encrypt (no plaintext passthrough);
 *  - garbage key messages and frames never throw.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { FrameKeyMessage } from '../api'
import { flip, flipped, runs } from '../fuzz-helpers'
import { sframe } from './sframe'
import { FrameKeyRing, ReplayWindow } from './transform'

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002'
const leaves = [
  { leafIndex: 0, userId: ALICE },
  { leafIndex: 1, userId: BOB },
]
type EpochMessage = Extract<FrameKeyMessage, { type: 'epoch' }>
const secrets: Uint8Array[] = [1, 2, 3].map((n) => new Uint8Array(32).fill(n))

type Op = { t: 'epoch'; epoch: number; secret: number } | { t: 'activate'; epoch: number } | { t: 'send'; video: boolean } | { t: 'resend' }

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('epoch' as const), epoch: fc.integer({ min: 0, max: 3 }), secret: fc.integer({ min: 0, max: 2 }) }),
  fc.record({ t: fc.constant('activate' as const), epoch: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ t: fc.constant('send' as const), video: fc.boolean() }),
  fc.constant({ t: 'resend' as const }),
)

describe('FrameKeyRing (fuzz)', () => {
  it('never reuses (key, KID, CTR) on the sender', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 40 }), async (ops) => {
        const ring = new FrameKeyRing()
        // The secret that each epoch holds now, as the ring was told.
        const installed = new Map<number, number>()
        let last: EpochMessage | null = null
        const seen = new Set<string>()
        for (const o of ops) {
          if (o.t === 'epoch' || o.t === 'resend') {
            // An MLS epoch has one exporter secret. The same epoch comes again only with the same secret.
            const msg: EpochMessage | null = o.t === 'resend' ? last : { type: 'epoch', epoch: o.epoch, secret: secrets[installed.get(o.epoch) ?? o.secret]!, selfLeaf: 0, leaves }
            if (msg === null) continue
            installed.set(msg.epoch, secrets.indexOf(msg.secret))
            ring.handle({ ...msg, secret: new Uint8Array(msg.secret) }, 0)
            last = msg
          } else if (o.t === 'activate') {
            ring.handle({ type: 'activate', epoch: o.epoch }, 0)
          } else {
            const codec = o.video ? 'vp8' : 'opus'
            const active = ring.activeEpoch
            const r = await ring.encrypt(new Uint8Array([0x90, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { track: o.video ? 'video' : 'audio', codec })
            if (!('frame' in r)) continue
            const h = sframe.decodeHeader(r.frame, sframe.clearPrefixLength(codec, r.frame))
            expect(active).not.toBeNull()
            const k = `${installed.get(active!)}/${h.kid}/${h.ctr}`
            expect(seen.has(k)).toBe(false)
            seen.add(k)
          }
        }
      }),
      runs(300),
    )
  })

  it('a receiver drops every frame the sender did not make, and never throws', async () => {
    const alice = new FrameKeyRing()
    const bob = new FrameKeyRing()
    alice.handle({ type: 'epoch', epoch: 1, secret: new Uint8Array(secrets[0]!), selfLeaf: 0, leaves }, 0)
    bob.handle({ type: 'epoch', epoch: 1, secret: new Uint8Array(secrets[0]!), selfLeaf: 1, leaves }, 0)
    alice.handle({ type: 'activate', epoch: 1 }, 0)
    bob.handle({ type: 'activate', epoch: 1 }, 0)
    const real = await alice.encrypt(new Uint8Array(40).fill(7), { track: 'audio', codec: 'opus' })
    if (!('frame' in real)) throw new Error('setup')
    await fc.assert(
      fc.asyncProperty(fc.oneof(flip.map((fl) => flipped(real.frame, fl)), fc.uint8Array({ maxLength: 120 })), async (frame) => {
        const r = await bob.decrypt(frame, { track: 'audio', codec: 'opus', userId: ALICE }, 0)
        expect('drop' in r).toBe(true)
      }),
      runs(1000),
    )
  })

  it('garbage key messages are ignored without a throw', () => {
    const msg = fc.oneof(
      fc.anything(),
      fc.record({ type: fc.constantFrom('epoch', 'activate', 'retire', 'close', 'other'), epoch: fc.oneof(fc.integer(), fc.double(), fc.string()), secret: fc.oneof(fc.uint8Array({ maxLength: 40 }), fc.anything()), selfLeaf: fc.anything(), leaves: fc.array(fc.record({ leafIndex: fc.anything(), userId: fc.anything() }), { maxLength: 3 }) }),
    )
    fc.assert(
      fc.property(fc.array(msg, { maxLength: 10 }), (msgs) => {
        const ring = new FrameKeyRing()
        for (const m of msgs) {
          try {
            ring.handle(m as FrameKeyMessage, 0)
          } catch (e) {
            // `leaves` must be iterable: a message without it is a programming error of the sender
            // Worker, not attacker input (FrameKeyMessage comes from the crypto Worker only).
            expect(e).toBeInstanceOf(TypeError)
          }
        }
      }),
      runs(2000),
    )
  })

  it('ReplayWindow accepts each counter at most once', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 3000n }), { maxLength: 200 }), (ctrs) => {
        const w = new ReplayWindow()
        const accepted = new Set<bigint>()
        for (const c of ctrs) {
          if (w.accept(c)) {
            expect(accepted.has(c)).toBe(false)
            accepted.add(c)
          }
        }
      }),
      runs(2000),
    )
  })
})
