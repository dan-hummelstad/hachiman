/**
 * Fuzz tests of the Takusen parsers that read untrusted request bodies and headers
 * (docs/e2ee-audit-scope.md §6). No dependency: a seeded PRNG drives the inputs.
 *
 *   FUZZ_ITERS=200000 FUZZ_SEED=7 node --import tsx --test src/lib/mls/__fuzz__/parsers.fuzz.test.ts
 *
 * Invariants:
 *  - every parser throws only its typed error (ParseError, ApiError, ZodError via safeParse);
 *  - the strict base64url decoder agrees with @hachiman/crypto's decoder on every string;
 *  - the binary framings accept only canonical bytes;
 *  - acceptEnvelope accepts only an envelope whose header names the request's group, channel,
 *    device and leaf.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { CodecError, fromB64url } from '@hachiman/crypto/codec'
import { FRANKING_KEY_LENGTH } from '@hachiman/crypto/constants'

import { reportSchema } from '@/app/api/v1/reports/report'
import { parseSignedActions, signedRoleCreateId } from '@/lib/admin-actions'
import { ApiError } from '@/lib/errors'
import { createMessageSchema, editMessageSchema } from '@/lib/wire'

import { b64, fromB64, ParseError, toB64, uuidToBytes } from '../bytes'
import { getDsModule } from '../crypto'
import { acceptEnvelopeWith } from '../envelopes'
import type { MlsRepo } from '../repo'
import { commitRequestSchema, declineBatchSchema, splitRejections } from '../schemas'
import { testEnvelope } from '../testing'
import { decodeWelcomeItem, encodeForTests, encodeWelcomeItem, parseGroupInfoContext, parseLinkOffer, parsePublicMessagePrefix, parseSealedDeviceMessage } from '../wire-format'

const ITERS = Number(process.env.FUZZ_ITERS ?? 3000)
const SEED = Number(process.env.FUZZ_SEED ?? 0x5eed)

/** mulberry32: small, seeded, good enough to drive a fuzzer. */
function prng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const bytes = (max: number) => Uint8Array.from({ length: int(max + 1) }, () => int(256))
  const pickOf = <T>(xs: readonly T[]): T => xs[int(xs.length)]!
  const str = (alphabet: string, max: number) => Array.from({ length: int(max + 1) }, () => alphabet[int(alphabet.length)]).join('')
  /** Byte overwrites, then a truncation or a tail. */
  const mutate = (b: Uint8Array): Uint8Array => {
    const out = b.slice()
    for (let k = int(4); k > 0 && out.length > 0; k--) out[int(out.length)] = int(256)
    switch (int(4)) {
      case 0:
        return out.subarray(0, int(out.length + 1))
      case 1:
        return Uint8Array.from([...out, ...bytes(3)])
      default:
        return out
    }
  }
  const json = (depth = 0): unknown => {
    switch (int(depth > 2 ? 6 : 8)) {
      case 0:
        return null
      case 1:
        return next() < 0.5
      case 2:
        return pickOf([0, -1, 1.5, 2 ** 53, Number.MAX_SAFE_INTEGER, 1e308, -0])
      case 3:
        return str('AZaz09-_=+/ \n\u0000é', 12)
      case 4:
        return toB64(bytes(48))
      case 5:
        return pickOf(['', '00000000-0000-4000-8000-000000000000', 'x'.repeat(70_000)])
      case 6:
        return Array.from({ length: int(4) }, () => json(depth + 1))
      default: {
        const keys = ['envelope', 'nonce', 'attachments', 'messageId', 'content', 'frankingKey', 'reason', '__proto__', 'constructor', 'extra']
        return Object.fromEntries(Array.from({ length: int(5) }, () => [pickOf(keys), json(depth + 1)]))
      }
    }
  }
  return { next, int, bytes, pickOf, str, mutate, json }
}

/** Runs fn and returns its value, or undefined when it threw one of the allowed classes. */
function only<T>(fn: () => T, ...allowed: (abstract new (...a: never[]) => Error)[]): T | undefined {
  try {
    return fn()
  } catch (e) {
    if (allowed.some((C) => e instanceof C)) return undefined
    throw e
  }
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=+/ \n'

describe('base64url (fuzz)', () => {
  test('fromB64 never throws, is strict, and agrees with @hachiman/crypto fromB64url', () => {
    const r = prng(SEED)
    for (let i = 0; i < ITERS * 10; i++) {
      const s = r.next() < 0.3 ? toB64(r.bytes(20)).slice(0, r.int(30)) : r.str(B64_ALPHABET, 12)
      const ours = fromB64(s)
      const theirs = only(() => fromB64url(s), CodecError)
      assert.equal(ours === null, theirs === undefined, `disagree on ${JSON.stringify(s)}`)
      if (ours) {
        assert.equal(toB64(ours), s)
        assert.deepEqual(ours, theirs)
      }
    }
  })

  test('b64(max) never throws and caps the decoded size', () => {
    const r = prng(SEED + 1)
    for (let i = 0; i < ITERS; i++) {
      const max = r.int(40)
      const res = b64(max).safeParse(r.json())
      if (res.success) assert.ok(res.data.length <= max)
    }
  })
})

describe('DS binary framings (fuzz)', () => {
  const r = prng(SEED + 2)
  const gid = uuidToBytes('11111111-1111-4111-8111-111111111111')
  const seeds = [
    encodeForTests.publicMessagePrefix({ groupId: gid, epoch: 5, senderLeaf: 3, contentType: 3 }, r.bytes(20)),
    encodeForTests.publicMessagePrefix({ groupId: gid, epoch: 0, senderLeaf: null, contentType: 2 }),
    encodeForTests.groupInfo({ cipherSuite: 1, groupId: gid, epoch: 9, treeHash: r.bytes(32), confirmedTranscriptHash: r.bytes(32) }, r.bytes(8)),
    encodeForTests.sealedDeviceMessage(2, gid),
    encodeForTests.linkOffer({ userId: gid, deviceId: gid, mlsSignatureKey: r.bytes(32).fill(1), hpkeKey: r.bytes(32).fill(2) }),
    encodeWelcomeItem(gid, 7, r.bytes(40)),
  ]

  test('every parser throws only ParseError', () => {
    for (let i = 0; i < ITERS * 5; i++) {
      const b = r.next() < 0.8 ? r.mutate(r.pickOf(seeds)) : r.bytes(120)
      only(() => parsePublicMessagePrefix(b), ParseError)
      only(() => parseGroupInfoContext(b), ParseError)
      only(() => parseSealedDeviceMessage(b), ParseError)
      only(() => parseLinkOffer(b), ParseError)
      const w = only(() => decodeWelcomeItem(b), ParseError)
      // WelcomeItem is the one framing that Takusen also writes: it must be canonical.
      if (w) assert.deepEqual(encodeWelcomeItem(w.groupId, w.epoch, w.welcome), b)
    }
  })

  test('parsePublicMessagePrefix reads back what the encoder wrote', () => {
    for (let i = 0; i < ITERS; i++) {
      const groupId = r.bytes(70)
      const epoch = r.int(2 ** 31) * 2 ** 21 + r.int(2 ** 21) // up to 2^52
      const senderLeaf = r.next() < 0.2 ? null : r.int(2 ** 32)
      const contentType = r.pickOf([2, 3] as const)
      const p = parsePublicMessagePrefix(encodeForTests.publicMessagePrefix({ groupId, epoch, senderLeaf, contentType }, r.bytes(30)))
      assert.deepEqual(p.groupId, groupId)
      assert.equal(p.epoch, epoch)
      assert.deepEqual(p.sender, senderLeaf === null ? { type: 'new_member_commit' } : { type: 'member', leafIndex: senderLeaf })
      assert.equal(p.contentType, contentType === 2 ? 'proposal' : 'commit')
    }
  })
})

describe('request bodies and headers (fuzz)', () => {
  test('message and report schemas never throw on arbitrary JSON', () => {
    const r = prng(SEED + 3)
    for (let i = 0; i < ITERS; i++) {
      const v = r.json()
      const c = createMessageSchema.safeParse(v)
      if (c.success) {
        assert.ok(c.data.envelope instanceof Uint8Array && c.data.envelope.length > 0)
        assert.equal(new Set(c.data.attachments).size, c.data.attachments.length)
      }
      const e = editMessageSchema.safeParse(v)
      if (e.success) assert.ok(e.data.envelope.length > 0)
      const rep = reportSchema.safeParse(v)
      if (rep.success) assert.ok(rep.data.frankingKey.length <= FRANKING_KEY_LENGTH)
    }
  })

  test('commit and decline schemas never throw; a rejection names exactly one kind', () => {
    const r = prng(SEED + 6)
    const uuid = '00000000-0000-4000-8000-000000000000'
    const rejection = (): unknown =>
      r.pickOf([
        () => ({ pendingId: r.pickOf([uuid, 'x', r.json()]), reason: r.pickOf(['policy', 'malformed', 'nope', r.json()]) }),
        () => ({ proposalRef: r.pickOf([toB64(r.bytes(40)), toB64(r.bytes(80)), r.json()]), reason: r.pickOf(['invalid_chain', r.json()]) }),
        () => ({ pendingId: uuid, proposalRef: toB64(r.bytes(32)), reason: 'policy' }),
        () => r.json(),
      ])()
    for (let i = 0; i < ITERS; i++) {
      const v = {
        epoch: r.pickOf([0, 3, -1, 1.5, r.json()]),
        commit: toB64(r.bytes(64)),
        groupInfo: toB64(r.bytes(64)),
        ratchetTree: toB64(r.bytes(64)),
        welcome: r.next() < 0.5 ? null : r.json(),
        batchId: r.pickOf([null, uuid, r.json()]),
        rejected: Array.from({ length: r.int(4) }, rejection),
        ...(r.next() < 0.5 ? { rejectedProposals: Array.from({ length: r.int(3) }, rejection) } : {}),
      }
      const c = commitRequestSchema.safeParse(r.next() < 0.1 ? r.json() : v)
      if (c.success) {
        for (const x of c.data.rejected) assert.ok(('pendingId' in x) !== ('proposalRef' in x))
        const split = only(() => splitRejections(c.data), ApiError)
        if (split) {
          assert.equal(split.rejected.length + split.rejectedProposals.length, c.data.rejected.length + c.data.rejectedProposals.length)
          for (const p of split.rejectedProposals) assert.ok(p.proposalRef instanceof Uint8Array && p.proposalRef.length <= 64)
        }
      }
      const d = declineBatchSchema.safeParse(r.next() < 0.5 ? { reason: r.pickOf(['busy', 'not_synced', r.json()]), rejectedProposals: v.rejected } : r.json())
      if (d.success) for (const p of d.data.rejectedProposals) assert.ok(p.proposalRef.length <= 64)
    }
  })

  test('X-Hachiman-Signed-Action parsing throws only ApiError', () => {
    const r = prng(SEED + 4)
    for (let i = 0; i < ITERS * 3; i++) {
      const parts = Array.from({ length: r.int(4) }, () => (r.next() < 0.7 ? toB64(r.bytes(r.next() < 0.05 ? 20_000 : 120)) : r.str(B64_ALPHABET, 10)))
      const header = r.next() < 0.1 ? null : parts.join(r.pickOf([',', ', ', ' ,', ',,']))
      const actions = only(() => parseSignedActions(header), ApiError)
      if (actions) for (const a of actions) assert.ok(a.length > 0 && a.length <= 16 * 1024)
      only(() => signedRoleCreateId(header), ApiError)
    }
  })
})

describe('acceptEnvelope (fuzz)', () => {
  test('a mutated envelope is refused with ApiError or names the same group, channel, device and leaf', async () => {
    const ds = await getDsModule()
    const r = prng(SEED + 5)
    const groupId = Uint8Array.from({ length: 22 }, (_, i) => i + 1)
    const channelId = '22222222-2222-4222-8222-222222222222'
    const deviceId = '33333333-3333-4333-8333-333333333333'
    const userId = '44444444-4444-4444-8444-444444444444'
    const now = new Date(1_000_000)
    // Only the methods acceptEnvelopeWith calls.
    const repo = {
      getChannel: async (id: string) => (id === channelId ? { id, mlsGroupId: groupId } : null),
      getGroup: async () => ({ groupId, status: 'active', epoch: 4, lastCommitRemoved: false, epochStartedAt: new Date(now.getTime() - 1000) }),
      memberByDevice: async (_g: Uint8Array, d: string) => (d === deviceId ? { userId, leafIndex: 2 } : null),
      messageClientMsgIdExists: async () => false,
    } as unknown as MlsRepo
    const valid = testEnvelope({ groupId, channelId, epoch: 4, senderLeaf: 2, senderDeviceId: deviceId })
    const ok = await acceptEnvelopeWith(repo, { ds, maxEnvelopeBytes: 32_768, now }, { channelId, userId, deviceId, envelope: valid, edit: false })
    assert.equal(ok.epoch, 4)
    for (let i = 0; i < ITERS; i++) {
      const envelope = r.next() < 0.9 ? r.mutate(valid) : r.bytes(200)
      try {
        const a = await acceptEnvelopeWith(repo, { ds, maxEnvelopeBytes: 32_768, now }, { channelId, userId, deviceId, envelope, edit: false })
        const h = ds.parseEnvelopeHeader(envelope)
        assert.deepEqual(h.groupId, groupId)
        assert.equal(h.channelId, channelId)
        assert.equal(h.senderDeviceId, deviceId)
        assert.equal(h.senderLeaf, 2)
        assert.ok(h.epoch === 4 || h.epoch === 3, `epoch ${h.epoch}`)
        assert.equal(a.size, envelope.length)
      } catch (e) {
        assert.ok(e instanceof ApiError, String(e))
        assert.ok(e.status >= 400 && e.status < 500, `${e.code} ${e.status}`)
      }
    }
  })
})
