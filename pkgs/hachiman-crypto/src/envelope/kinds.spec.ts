/** Envelope kinds 3 'reaction' and 4 'page_activity' (§12.8.1, §12.8.5 step 7). */
import { describe, expect, it } from 'vitest'

import type { DecryptFailure, EnvelopeHeader, EnvelopeOpenResult, KindedContent, PageActivityContent, ReactionContent } from '../api'
import { CryptoError } from '../api'
import { Writer, toB64url, uuidToBytes } from '../codec'
import { EnvelopeKind, MAX_PAGE_ACTIVITY_CHANGES, MAX_REACTION_EMOJI_LENGTH } from '../constants'
import { generateEd25519 } from '../sign'
import { decodeContent, encodeContent } from './codec'
import { bytes, content, uuid } from './fixtures'
import { envelope } from './index'

const TARGET = toB64url(bytes(16, 0x7a))
const PAGE = uuid(77)

function reaction(over: Partial<ReactionContent> = {}): ReactionContent {
  return { target: TARGET, emoji: '👍', remove: false, sentAtMs: 1_700_000_000_000, ...over }
}

function activity(over: Partial<PageActivityContent> = {}): PageActivityContent {
  return { pageId: PAGE, changes: 2, sentAtMs: 1_700_000_000_000, ...over }
}

function expectMalformed(fn: () => unknown): void {
  let thrown: unknown = null
  try {
    fn()
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(CryptoError)
  expect((thrown as CryptoError).code).toBe('Malformed')
}

function expectRejected(fn: () => unknown): void {
  expect(fn).toThrow(CryptoError)
}

/** A kind 3 content with raw fields, so a test can break one rule at a time. */
function rawReaction(emoji: Uint8Array, remove: number, target = bytes(16, 0x7a)): Uint8Array {
  return new Writer().u8(EnvelopeKind.REACTION).fixed(target, 16).opaque(emoji).u8(remove).u64(1).optional(null, (w, v: Uint8Array) => w.opaque(v)).finish()
}

function rawActivity(changes: number): Uint8Array {
  return new Writer().u8(EnvelopeKind.PAGE_ACTIVITY).fixed(uuidToBytes(PAGE), 16).u32(changes).u64(1).optional(null, (w, v: Uint8Array) => w.opaque(v)).finish()
}

describe('EnvelopeContent kind reaction', () => {
  it('round-trips, with and without KT gossip and remove', () => {
    for (const c of [reaction(), reaction({ remove: true }), reaction({ emoji: '👩🏽‍💻' }), reaction({ emoji: 'a'.repeat(MAX_REACTION_EMOJI_LENGTH) })]) {
      for (const kt of [null, bytes(40, 3)]) {
        const b = encodeContent({ kind: 'reaction', editOf: null, content: c, ktTreeHead: kt })
        expect(b[0]).toBe(EnvelopeKind.REACTION)
        expect(decodeContent(b)).toEqual({ kind: 'reaction', editOf: null, content: c, ktTreeHead: kt })
      }
    }
  })

  it('rejects a bad emoji, target or remove on encode', () => {
    const enc = (c: ReactionContent) => () => encodeContent({ kind: 'reaction', editOf: null, content: c, ktTreeHead: null })
    expectMalformed(enc(reaction({ emoji: '' })))
    expectRejected(enc(reaction({ emoji: 'a'.repeat(MAX_REACTION_EMOJI_LENGTH + 1) })))
    expectMalformed(enc(reaction({ emoji: 'ok\n' })))
    expectMalformed(enc(reaction({ emoji: '\u0000' })))
    expectMalformed(enc(reaction({ emoji: '\u007f' })))
    expectMalformed(enc(reaction({ emoji: '\ud83d' })))
    expectMalformed(enc(reaction({ target: toB64url(bytes(15, 1)) })))
    expectMalformed(enc(reaction({ target: 'not base64url!' })))
    const withEditOf = { kind: 'reaction', editOf: bytes(16, 1), content: reaction(), ktTreeHead: null } as unknown as KindedContent<Uint8Array> & { ktTreeHead: null }
    expectMalformed(() => encodeContent(withEditOf))
  })

  it('rejects malformed reaction content on decode', () => {
    const utf8 = (s: string) => new TextEncoder().encode(s)
    expect(decodeContent(rawReaction(utf8('🎉'), 1)).content).toMatchObject({ emoji: '🎉', remove: true })
    expectMalformed(() => decodeContent(rawReaction(utf8(''), 0)))
    expectMalformed(() => decodeContent(rawReaction(utf8('a'.repeat(MAX_REACTION_EMOJI_LENGTH + 1)), 0)))
    expectMalformed(() => decodeContent(rawReaction(utf8('😀'.repeat(17)), 0)))
    expectMalformed(() => decodeContent(rawReaction(utf8('\u0007'), 0)))
    expectMalformed(() => decodeContent(rawReaction(utf8('\u0085'), 0)))
    expectMalformed(() => decodeContent(rawReaction(new Uint8Array([0xff, 0xfe]), 0)))
    expectMalformed(() => decodeContent(rawReaction(utf8('👍'), 2)))
    const good = rawReaction(utf8('👍'), 0)
    expectMalformed(() => decodeContent(good.slice(0, good.length - 1)))
    const long = new Uint8Array(good.length + 1)
    long.set(good)
    expectMalformed(() => decodeContent(long))
  })
})

describe('EnvelopeContent kind page_activity', () => {
  it('round-trips', () => {
    for (const changes of [1, 2, MAX_PAGE_ACTIVITY_CHANGES]) {
      const c = activity({ changes })
      const b = encodeContent({ kind: 'page_activity', editOf: null, content: c, ktTreeHead: null })
      expect(b[0]).toBe(EnvelopeKind.PAGE_ACTIVITY)
      expect(decodeContent(b)).toEqual({ kind: 'page_activity', editOf: null, content: c, ktTreeHead: null })
    }
  })

  it('rejects bad changes or page id on encode and decode', () => {
    const enc = (c: PageActivityContent) => () => encodeContent({ kind: 'page_activity', editOf: null, content: c, ktTreeHead: null })
    for (const changes of [0, -1, 1.5, MAX_PAGE_ACTIVITY_CHANGES + 1, Number.NaN]) expectMalformed(enc(activity({ changes })))
    expectMalformed(enc(activity({ pageId: 'not-a-uuid' })))
    expectMalformed(enc(activity({ pageId: PAGE.toUpperCase() })))
    expect(decodeContent(rawActivity(7)).content).toMatchObject({ pageId: PAGE, changes: 7 })
    expectMalformed(() => decodeContent(rawActivity(0)))
    expectMalformed(() => decodeContent(rawActivity(MAX_PAGE_ACTIVITY_CHANGES + 1)))
    expectMalformed(() => decodeContent(rawActivity(0xffffffff)))
  })
})

describe('kind confusion', () => {
  it('a reaction does not decode as an edit, and an edit does not decode as a reaction', () => {
    const r = encodeContent({ kind: 'reaction', editOf: null, content: reaction(), ktTreeHead: null })
    const e = encodeContent({ kind: 'edit', editOf: bytes(16, 0x7a), content: content(), ktTreeHead: null })
    const p = encodeContent({ kind: 'page_activity', editOf: null, content: activity(), ktTreeHead: null })
    const withKind = (b: Uint8Array, kind: number) => {
      const out = b.slice()
      out[0] = kind
      return out
    }
    for (const kind of [EnvelopeKind.MESSAGE, EnvelopeKind.EDIT, EnvelopeKind.PAGE_ACTIVITY]) expectMalformed(() => decodeContent(withKind(r, kind)))
    for (const kind of [EnvelopeKind.REACTION, EnvelopeKind.PAGE_ACTIVITY]) expectMalformed(() => decodeContent(withKind(e, kind)))
    for (const kind of [EnvelopeKind.MESSAGE, EnvelopeKind.EDIT, EnvelopeKind.REACTION]) expectMalformed(() => decodeContent(withKind(p, kind)))
  })

  it('an unknown kind byte is malformed (what an older client does with a newer kind)', () => {
    const r = encodeContent({ kind: 'reaction', editOf: null, content: reaction(), ktTreeHead: null })
    for (const kind of [0, 5, 255]) {
      const out = r.slice()
      out[0] = kind
      expectMalformed(() => decodeContent(out))
    }
  })
})

describe('seal and open of the new kinds', () => {
  const sender = generateEd25519()
  const epochSecret = bytes(32, 0x5e)
  const header: Omit<EnvelopeHeader, 'salt' | 'frankingTag'> = {
    groupId: bytes(22, 7),
    channelId: uuid(1),
    epoch: 9,
    senderLeaf: 4,
    senderDeviceId: uuid(2),
    clientMsgId: bytes(16, 0xc1),
  }
  const keys = { epochSecret, signatureKey: sender.privateKey, ktTreeHead: null }
  const failureOf = (r: EnvelopeOpenResult | { failure: DecryptFailure }): DecryptFailure | null => ('failure' in r ? r.failure : null)

  it('opens a reaction and a page activity, and gives senderKey the decoded kind', async () => {
    const kinds: string[] = []
    const okKey = (_h: EnvelopeHeader, kind: string) => {
      kinds.push(kind)
      return Promise.resolve({ signatureKey: sender.publicKey })
    }
    const r = await envelope.open(await envelope.seal({ ...keys, header, kind: 'reaction', editOf: null, content: reaction() }), epochSecret, okKey)
    expect(r).toMatchObject({ kind: 'reaction', editOf: null, content: reaction() })
    const p = await envelope.open(await envelope.seal({ ...keys, header, kind: 'page_activity', editOf: null, content: activity() }), epochSecret, okKey)
    expect(p).toMatchObject({ kind: 'page_activity', editOf: null, content: activity() })
    expect(kinds).toEqual(['reaction', 'page_activity'])
  })

  it('step 7: a reaction on its own client_msg_id is malformed', async () => {
    const okKey = () => Promise.resolve({ signatureKey: sender.publicKey })
    const self = reaction({ target: toB64url(header.clientMsgId) })
    const env = await envelope.seal({ ...keys, header, kind: 'reaction', editOf: null, content: self })
    expect(failureOf(await envelope.open(env, epochSecret, okKey))).toBe('malformed')
  })
})
