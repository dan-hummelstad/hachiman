import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { EnvelopeHeader, MessageContent } from '../api'
import { CryptoError } from '../api'
import { toB64url } from '../codec'
import { MAX_ENVELOPE_BYTES } from '../constants'
import {
  HEADER_LENGTH,
  decodeContent,
  decodeEnvelope,
  decodePlaintext,
  encodeContent,
  encodeEnvelope,
  encodeHeader,
  encodePlaintext,
  envelopeLength,
  uploadIdsOf,
} from './codec'
import { bytes, content, largestContent, pointer, thumbnail, uuid } from './fixtures'

function header(overrides: Partial<EnvelopeHeader> = {}): EnvelopeHeader {
  return {
    groupId: bytes(22, 7),
    channelId: uuid(1),
    epoch: 42,
    senderLeaf: 3,
    senderDeviceId: uuid(2),
    clientMsgId: bytes(16, 9),
    salt: bytes(32, 1),
    frankingTag: bytes(32, 2),
    ...overrides,
  }
}

function expectMalformed(fn: () => unknown): void {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(CryptoError)
    expect((e as CryptoError).code).toBe('Malformed')
    return
  }
  throw new Error('expected CryptoError(Malformed)')
}

describe('EnvelopeHeader', () => {
  it('round-trips and has the fixed length', () => {
    const h = header()
    const hb = encodeHeader(h)
    expect(hb.length).toBe(HEADER_LENGTH)
    expect(hb[0]).toBe(0x48)
    expect(hb[1]).toBe(0x01)
    const env = encodeEnvelope(hb, bytes(10, 5))
    const d = decodeEnvelope(env)
    expect(d.header).toEqual(h)
    expect(d.headerBytes).toEqual(hb)
    expect(d.ciphertext).toEqual(bytes(10, 5))
  })

  it('rejects bad field lengths on encode', () => {
    expectMalformed(() => encodeHeader(header({ groupId: bytes(21, 0) })))
    expectMalformed(() => encodeHeader(header({ clientMsgId: bytes(15, 0) })))
    expectMalformed(() => encodeHeader(header({ salt: bytes(31, 0) })))
    expectMalformed(() => encodeHeader(header({ frankingTag: bytes(33, 0) })))
    expectMalformed(() => encodeHeader(header({ channelId: 'NOT-A-UUID' })))
    expectMalformed(() => encodeHeader(header({ epoch: -1 })))
  })

  it('rejects a bad magic, a short group id and trailing bytes', () => {
    const env = encodeEnvelope(encodeHeader(header()), bytes(4, 0))
    const badMagic = env.slice()
    badMagic[1] = 0x02
    expectMalformed(() => decodeEnvelope(badMagic))
    const shortGroup = env.slice()
    shortGroup[2] = 21
    expectMalformed(() => decodeEnvelope(shortGroup))
    const trailing = new Uint8Array(env.length + 1)
    trailing.set(env)
    expectMalformed(() => decodeEnvelope(trailing))
    expectMalformed(() => decodeEnvelope(env.slice(0, env.length - 1)))
  })

  it('fuzz: mutated envelopes decode or throw CryptoError, never anything else', () => {
    const env = encodeEnvelope(encodeHeader(header()), bytes(40, 3))
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(env.length - 1), fc.integer({ min: 0, max: 255 })), { maxLength: 6 }), fc.nat(env.length), (edits, cut) => {
        const m = env.slice(0, cut === 0 ? env.length : cut)
        for (const [i, v] of edits) if (i < m.length) m[i] = v
        try {
          decodeEnvelope(m)
        } catch (e) {
          expect(e).toBeInstanceOf(CryptoError)
        }
      }),
      { numRuns: 2000 },
    )
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (b) => {
        try {
          decodeEnvelope(b)
        } catch (e) {
          expect(e).toBeInstanceOf(CryptoError)
        }
      }),
      { numRuns: 2000 },
    )
  })
})

describe('EnvelopeContent', () => {
  it('round-trips a full content', () => {
    const c: MessageContent = content({
      mentions: [
        { type: 'user', id: uuid(5) },
        { type: 'role', id: uuid(6) },
        { type: 'everyone', id: null },
      ],
      attachments: [pointer(1, { thumbnail: thumbnail(2) }), pointer(3, { width: null, height: null, blurhash: null, mime: 'application/octet-stream' })],
      replyTo: toB64url(bytes(16, 8)),
    })
    for (const kt of [null, bytes(100, 1)]) {
      const b = encodeContent({ kind: 'message', editOf: null, content: c, ktTreeHead: kt })
      expect(decodeContent(b)).toEqual({ kind: 'message', editOf: null, content: c, ktTreeHead: kt })
    }
    const e = encodeContent({ kind: 'edit', editOf: bytes(16, 4), content: c, ktTreeHead: null })
    expect(decodeContent(e)).toEqual({ kind: 'edit', editOf: bytes(16, 4), content: c, ktTreeHead: null })
  })

  it('maps 0 to null for optional dimensions', () => {
    const b = encodeContent({ kind: 'message', editOf: null, content: content({ attachments: [pointer(1, { width: 0, durationMs: 0 })] }), ktTreeHead: null })
    const d = decodeContent(b)
    if (d.kind !== 'message') throw new Error('not a message')
    const p = d.content.attachments[0]!
    expect(p.width).toBeNull()
    expect(p.durationMs).toBeNull()
  })

  it('lists upload ids as file, then thumbnail', () => {
    const list = uploadIdsOf([pointer(1, { thumbnail: thumbnail(2, { blobSize: 9 }) }), pointer(3)])
    expect(list).toEqual([
      { id: uuid(1), blobSize: 106_525 },
      { id: uuid(2), blobSize: 9 },
      { id: uuid(3), blobSize: 106_525 },
    ])
  })

  it('a link preview rides kinds 5 and 6, and its image is the last upload id', () => {
    const linkPreview = { url: 'https://example.com/a', title: 'T', description: '', siteName: 'Ex', image: thumbnail(9, { blobSize: 7 }) }
    const c = content({ attachments: [pointer(1)], linkPreview })
    const m = encodeContent({ kind: 'message', editOf: null, content: c, ktTreeHead: null })
    const e = encodeContent({ kind: 'edit', editOf: bytes(16, 1), content: c, ktTreeHead: null })
    expect([m[0], e[0]]).toEqual([5, 6])
    expect(decodeContent(m)).toMatchObject({ kind: 'message', content: c })
    expect(decodeContent(e)).toMatchObject({ kind: 'edit', content: c })
    expect(uploadIdsOf(c.attachments, linkPreview)).toEqual([
      { id: uuid(1), blobSize: 106_525 },
      { id: uuid(9), blobSize: 7 },
    ])
    // Without a preview the bytes stay those of kinds 1 and 2.
    expect(encodeContent({ kind: 'message', editOf: null, content: content(), ktTreeHead: null })[0]).toBe(1)
    // Kind 1 with the preview bytes, or kind 5 without them, does not decode.
    expectMalformed(() => decodeContent(Uint8Array.of(1, ...m.subarray(1))))
    const plain = encodeContent({ kind: 'message', editOf: null, content: content(), ktTreeHead: null })
    expectMalformed(() => decodeContent(Uint8Array.of(5, ...plain.subarray(1))))
  })

  it('rejects a link preview url that is not https, or too long a field', () => {
    const enc = (p: Partial<NonNullable<MessageContent['linkPreview']>>): Uint8Array =>
      encodeContent({
        kind: 'message',
        editOf: null,
        content: content({ linkPreview: { url: 'https://a.example/', title: '', description: '', siteName: '', image: null, ...p } }),
        ktTreeHead: null,
      })
    for (const url of ['http://a.example/', 'javascript:alert(1)', '', 'not a url']) expectMalformed(() => enc({ url }))
    expect(() => enc({ title: 't'.repeat(301) })).toThrow(/title/)
    expect(() => enc({ description: 'd'.repeat(1001) })).toThrow(/description/)
    expect(() => enc({ siteName: 's'.repeat(101) })).toThrow(/site_name/)
    expect(enc({}).length).toBeGreaterThan(0)
  })

  it('enforces the §12.8.1 limits on encode', () => {
    const enc = (c: Partial<MessageContent>): Uint8Array => encodeContent({ kind: 'message', editOf: null, content: content(c), ktTreeHead: null })
    const code = (fn: () => unknown): string => {
      try {
        fn()
      } catch (e) {
        return (e as CryptoError).code
      }
      return 'none'
    }
    expect(code(() => enc({ text: 'a'.repeat(8000) }))).toBe('none')
    expect(code(() => enc({ text: 'a'.repeat(8001) }))).toBe('TooLarge')
    expect(code(() => enc({ text: 'é'.repeat(4001) }))).toBe('TooLarge')
    expect(code(() => enc({ mentions: Array.from({ length: 101 }, (_, i) => ({ type: 'user' as const, id: uuid(i) })) }))).toBe('TooLarge')
    expect(code(() => enc({ attachments: Array.from({ length: 11 }, (_, i) => pointer(i)) }))).toBe('TooLarge')
    expect(code(() => enc({ text: '', attachments: [] }))).toBe('Malformed')
    expect(code(() => enc({ attachments: [pointer(1, { name: '' })] }))).toBe('Malformed')
    expect(code(() => enc({ attachments: [pointer(1, { name: 'n'.repeat(256) })] }))).toBe('TooLarge')
    expect(code(() => enc({ attachments: [pointer(1, { mime: 'Image/PNG' })] }))).toBe('Malformed')
    expect(code(() => enc({ attachments: [pointer(1, { mime: 'text/plain; charset=utf-8' })] }))).toBe('Malformed')
    expect(code(() => enc({ attachments: [pointer(1, { blurhash: 'b'.repeat(101) })] }))).toBe('TooLarge')
    expect(code(() => enc({ attachments: [pointer(1, { blurhash: '' })] }))).toBe('Malformed')
    expect(code(() => enc({ attachments: [pointer(1, { blurhash: 'é' })] }))).toBe('Malformed')
    expect(code(() => enc({ attachments: [pointer(1, { key: toB64url(bytes(31, 0)) })] }))).toBe('Malformed')
    expect(code(() => enc({ attachments: [pointer(1, { size: -1 })] }))).toBe('Malformed')
    expect(code(() => enc({ attachments: [pointer(1, { thumbnail: thumbnail(2, { width: -1 }) })] }))).toBe('Malformed')
    expect(code(() => enc({ mentions: [{ type: 'everyone', id: uuid(1) }] }))).toBe('Malformed')
    expect(code(() => enc({ mentions: [{ type: 'user', id: null }] }))).toBe('Malformed')
    expect(code(() => enc({ replyTo: toB64url(bytes(15, 0)) }))).toBe('Malformed')
    expect(code(() => encodeContent({ kind: 'message', editOf: bytes(16, 0), content: content(), ktTreeHead: null }))).toBe('Malformed')
    expect(code(() => encodeContent({ kind: 'edit', editOf: null, content: content(), ktTreeHead: null }))).toBe('Malformed')
  })

  it('rejects a non-zero everyone id, an unknown mention type and an unknown kind on decode', () => {
    const b = encodeContent({ kind: 'message', editOf: null, content: content({ mentions: [{ type: 'everyone', id: null }] }), ktTreeHead: null })
    // kind(1) flag(1) text<V>(1 + 5) mentions<V>(1) type(1) id(16)
    const mentionAt = 1 + 1 + 6 + 1
    const nonZero = b.slice()
    nonZero[mentionAt + 1] = 1
    expectMalformed(() => decodeContent(nonZero))
    const badType = b.slice()
    badType[mentionAt] = 4
    expectMalformed(() => decodeContent(badType))
    const badKind = b.slice()
    badKind[0] = 3
    expectMalformed(() => decodeContent(badKind))
    const badFlag = b.slice()
    badFlag[1] = 2
    expectMalformed(() => decodeContent(badFlag))
  })

  it('the largest valid content stays under MAX_ENVELOPE_BYTES', () => {
    const c = largestContent()
    const b = encodeContent({ kind: 'edit', editOf: bytes(16, 1), content: c, ktTreeHead: bytes(128, 1) })
    expect(decodeContent(b).content).toEqual(c)
    const size = envelopeLength(b.length)
    expect(size).toBeLessThan(MAX_ENVELOPE_BYTES)
    expect(size).toBeGreaterThan(18_000)
  })

  it('fuzz: mutated content decodes or throws CryptoError', () => {
    const b = encodeContent({
      kind: 'message',
      editOf: null,
      content: content({ mentions: [{ type: 'user', id: uuid(1) }], attachments: [pointer(1, { thumbnail: thumbnail(2) })] }),
      ktTreeHead: bytes(20, 1),
    })
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(b.length - 1), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 8 }), fc.nat(b.length), (edits, cut) => {
        const m = b.slice(0, cut === 0 ? b.length : cut)
        for (const [i, v] of edits) if (i < m.length) m[i] = v
        try {
          decodeContent(m)
        } catch (e) {
          expect(e).toBeInstanceOf(CryptoError)
        }
      }),
      { numRuns: 3000 },
    )
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (r) => {
        try {
          decodeContent(r)
          decodePlaintext(r)
        } catch (e) {
          expect(e).toBeInstanceOf(CryptoError)
        }
      }),
      { numRuns: 2000 },
    )
  })
})

describe('EnvelopePlaintext', () => {
  it('round-trips and keeps the exact content bytes', () => {
    const cb = encodeContent({ kind: 'message', editOf: null, content: content(), ktTreeHead: null })
    const p = encodePlaintext(cb, bytes(32, 3), bytes(64, 4))
    const d = decodePlaintext(p)
    expect(d.contentBytes).toEqual(cb)
    expect(d.frankingKey).toEqual(bytes(32, 3))
    expect(d.signature).toEqual(bytes(64, 4))
    expect(d.content).toEqual(content())
  })

  it('rejects a short signature and trailing bytes', () => {
    const cb = encodeContent({ kind: 'message', editOf: null, content: content(), ktTreeHead: null })
    expectMalformed(() => decodePlaintext(encodePlaintext(cb, bytes(32, 3), bytes(63, 4))))
    const p = encodePlaintext(cb, bytes(32, 3), bytes(64, 4))
    const t = new Uint8Array(p.length + 1)
    t.set(p)
    expectMalformed(() => decodePlaintext(t))
  })
})
