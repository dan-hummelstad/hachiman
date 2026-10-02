import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { DecryptFailure, EnvelopeHeader, EnvelopeOpenResult } from '../api'
import { Writer } from '../codec'
import { generateEd25519, signWithLabel } from '../sign'
import { HEADER_LENGTH, decodeEnvelope, decodePlaintext, encodeContentUnchecked, encodeEnvelope, encodeHeader, encodePlaintext } from './codec'
import { bytes, content, hex, pointer, uuid } from './fixtures'
import { envelope, envelopeSignedContent, sealContentBytes } from './index'

const sender = generateEd25519()
const epochSecret = bytes(32, 0x5e)
const baseHeader: Omit<EnvelopeHeader, 'salt' | 'frankingTag'> = {
  groupId: bytes(22, 7),
  channelId: uuid(1),
  epoch: 9,
  senderLeaf: 4,
  senderDeviceId: uuid(2),
  clientMsgId: bytes(16, 0xc1),
}

const okKey = () => Promise.resolve({ signatureKey: sender.publicKey })

function seal(over: { kind?: 'message' | 'edit'; editOf?: Uint8Array | null } = {}): Promise<Uint8Array> {
  return envelope.seal({
    header: baseHeader,
    kind: over.kind ?? 'message',
    editOf: over.editOf ?? null,
    content: content({ attachments: [pointer(1)] }),
    epochSecret,
    signatureKey: sender.privateKey,
    ktTreeHead: bytes(50, 1),
  })
}

function failureOf(r: EnvelopeOpenResult | { failure: DecryptFailure }): DecryptFailure | null {
  return 'failure' in r ? r.failure : null
}

/** Splits an envelope into header bytes and plaintext bytes (by decrypting with the known key). */
async function decryptRaw(env: Uint8Array): Promise<{ headerBytes: Uint8Array; header: EnvelopeHeader; plaintext: Uint8Array }> {
  const { header, headerBytes, ciphertext } = decodeEnvelope(env)
  const key = await envelope.deriveMessageKey(epochSecret, header.salt, header.senderLeaf)
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, ['decrypt'])
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12), additionalData: new Uint8Array(headerBytes) }, k, new Uint8Array(ciphertext))
  return { headerBytes, header, plaintext: new Uint8Array(pt) }
}

/** Re-encrypts a plaintext under a header, with a valid AEAD (an attacker that holds S_e). */
async function encryptRaw(header: EnvelopeHeader, plaintext: Uint8Array): Promise<Uint8Array> {
  const hb = encodeHeader(header)
  const key = await envelope.deriveMessageKey(epochSecret, header.salt, header.senderLeaf)
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, ['encrypt'])
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12), additionalData: new Uint8Array(hb) }, k, new Uint8Array(plaintext))
  return encodeEnvelope(hb, new Uint8Array(ct))
}

describe('message key', () => {
  it('matches the pinned K_msg vector', async () => {
    // HKDF-SHA256(salt = 20..3f, IKM = 00..1f, info = "hachiman msg key v1" ‖ uint32(7)), from Node's crypto.hkdfSync.
    const se = Uint8Array.from({ length: 32 }, (_, i) => i)
    const salt = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i)
    expect(hex(await envelope.deriveMessageKey(se, salt, 7))).toBe('a9b0d202a19a0cb6cca2663a3d2a40077f5d0f0f0b732bbb2cf2df9f191e7b60')
  })

  it('agrees with WebCrypto HKDF and depends on the sender leaf', async () => {
    const salt = bytes(32, 3)
    const ikm = await crypto.subtle.importKey('raw', new Uint8Array(epochSecret), 'HKDF', false, ['deriveBits'])
    const info = new Writer().fixed(new TextEncoder().encode('hachiman msg key v1'), 19).u32(4).finish()
    const ref = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt), info: new Uint8Array(info) }, ikm, 256))
    expect(await envelope.deriveMessageKey(epochSecret, salt, 4)).toEqual(ref)
    expect(await envelope.deriveMessageKey(epochSecret, salt, 5)).not.toEqual(ref)
  })

  it('rejects wrong secret and salt lengths', async () => {
    await expect(envelope.deriveMessageKey(bytes(31, 0), bytes(32, 0), 0)).rejects.toThrow()
    await expect(envelope.deriveMessageKey(bytes(32, 0), bytes(16, 0), 0)).rejects.toThrow()
  })
})

describe('seal and open', () => {
  it('round-trips a message', async () => {
    const env = await seal()
    const r = await envelope.open(env, epochSecret, okKey)
    expect(failureOf(r)).toBeNull()
    const o = r as EnvelopeOpenResult
    expect(o.kind).toBe('message')
    expect(o.editOf).toBeNull()
    expect(o.content).toEqual(content({ attachments: [pointer(1)] }))
    expect(o.ktTreeHead).toEqual(bytes(50, 1))
    expect(o.header.clientMsgId).toEqual(baseHeader.clientMsgId)
    expect(envelope.decodeContent(o.contentBytes).content).toEqual(o.content)
    expect(envelope.decodeHeader(env).headerBytes.length).toBe(HEADER_LENGTH)
  })

  it('uses a fresh salt and franking key per seal', async () => {
    const a = envelope.decodeHeader(await seal()).header
    const b = envelope.decodeHeader(await seal()).header
    expect(a.salt).not.toEqual(b.salt)
    expect(a.frankingTag).not.toEqual(b.frankingTag)
  })

  it('round-trips an edit, which keeps the client_msg_id', async () => {
    const env = await seal({ kind: 'edit', editOf: baseHeader.clientMsgId })
    const o = (await envelope.open(env, epochSecret, okKey)) as EnvelopeOpenResult
    expect(o.kind).toBe('edit')
    expect(o.editOf).toEqual(baseHeader.clientMsgId)
  })

  it('seal refuses an edit whose edit_of is not the header client_msg_id', async () => {
    await expect(seal({ kind: 'edit', editOf: bytes(16, 1) })).rejects.toThrow()
    await expect(seal({ kind: 'edit', editOf: null })).rejects.toThrow()
    await expect(seal({ kind: 'message', editOf: baseHeader.clientMsgId })).rejects.toThrow()
  })

  it('gives aead for a wrong epoch secret', async () => {
    expect(failureOf(await envelope.open(await seal(), bytes(32, 0), okKey))).toBe('aead')
    expect(failureOf(await envelope.open(await seal(), bytes(5, 0), okKey))).toBe('aead')
  })

  it('gives aead when any header field changes (the header is the AAD)', async () => {
    const env = await seal()
    const { header, ciphertext } = decodeEnvelope(env)
    const variants: Partial<EnvelopeHeader>[] = [
      { groupId: bytes(22, 8) },
      { channelId: uuid(99) },
      { epoch: 10 },
      { senderLeaf: 5 },
      { senderDeviceId: uuid(98) },
      { clientMsgId: bytes(16, 0xc2) },
      { salt: bytes(32, 0) },
      { frankingTag: bytes(32, 0) },
    ]
    for (const v of variants) {
      const tampered = encodeEnvelope(encodeHeader({ ...header, ...v }), ciphertext)
      expect(failureOf(await envelope.open(tampered, epochSecret, okKey))).toBe('aead')
    }
  })

  it('gives malformed for an envelope that does not decode', async () => {
    const env = await seal()
    expect(failureOf(await envelope.open(env.slice(0, 20), epochSecret, okKey))).toBe('malformed')
  })

  it('passes the senderKey failure through and gives the decoded kind', async () => {
    const env = await seal({ kind: 'edit', editOf: baseHeader.clientMsgId })
    let seenKind: string | null = null
    const r = await envelope.open(env, epochSecret, (_h, kind) => {
      seenKind = kind
      return Promise.resolve({ failure: 'edit_not_author' })
    })
    expect(seenKind).toBe('edit')
    expect(failureOf(r)).toBe('edit_not_author')
  })

  it('gives bad_signature for another signer', async () => {
    const other = generateEd25519()
    const r = await envelope.open(await seal(), epochSecret, () => Promise.resolve({ signatureKey: other.publicKey }))
    expect(failureOf(r)).toBe('bad_signature')
  })

  it('gives bad_franking when the tag does not match the content', async () => {
    const env = await seal()
    const { header, plaintext } = await decryptRaw(env)
    // Same content and franking key, a header with another franking tag, signed by the real sender.
    const p = decodePlaintext(plaintext)
    const badHeader: EnvelopeHeader = { ...header, frankingTag: bytes(32, 0x77) }
    const sig = signWithLabel(sender.privateKey, 'Envelope', envelopeSignedContent(encodeHeader(badHeader), p.contentBytes))
    const forged = await encryptRaw(badHeader, encodePlaintext(p.contentBytes, p.frankingKey, sig))
    expect(failureOf(await envelope.open(forged, epochSecret, okKey))).toBe('bad_franking')
  })

  it('gives malformed for a kind/edit_of mismatch (step 7), after the signature and franking pass', async () => {
    const seal7 = (kind: 'message' | 'edit', editOf: Uint8Array | null) =>
      sealContentBytes(
        { header: baseHeader, epochSecret, signatureKey: sender.privateKey },
        encodeContentUnchecked({ kind, editOf, content: content(), ktTreeHead: null }),
      )
    expect(failureOf(await envelope.open(await seal7('message', bytes(16, 1)), epochSecret, okKey))).toBe('malformed')
    expect(failureOf(await envelope.open(await seal7('edit', null), epochSecret, okKey))).toBe('malformed')
    expect(failureOf(await envelope.open(await seal7('edit', bytes(16, 1)), epochSecret, okKey))).toBe('malformed')
    expect(failureOf(await envelope.open(await seal7('edit', baseHeader.clientMsgId), epochSecret, okKey))).toBeNull()
  })

  it('gives malformed for a plaintext that breaks a limit', async () => {
    const env = await seal()
    const { header, plaintext } = await decryptRaw(env)
    const t = new Uint8Array(plaintext.length + 1)
    t.set(plaintext)
    expect(failureOf(await envelope.open(await encryptRaw(header, t), epochSecret, okKey))).toBe('malformed')
  })

  it('fuzz: open never throws on mutated envelopes', async () => {
    const env = await seal()
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.nat(env.length - 1), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 4 }), fc.nat(env.length), async (edits, cut) => {
        const m = env.slice(0, cut === 0 ? env.length : cut)
        let changed = cut !== 0 && cut !== env.length
        for (const [i, v] of edits) {
          if (i < m.length && m[i] !== v) {
            m[i] = v
            changed = true
          }
        }
        const r = await envelope.open(m, epochSecret, okKey)
        if (changed) expect(failureOf(r)).not.toBeNull()
      }),
      { numRuns: 500 },
    )
  })

  it('fuzz: open never throws on mutated plaintexts under a valid AEAD', async () => {
    const env = await seal()
    const { header, plaintext } = await decryptRaw(env)
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.nat(plaintext.length - 1), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 4 }), async (edits) => {
        const m = plaintext.slice()
        for (const [i, v] of edits) m[i] = v
        const r = await envelope.open(await encryptRaw(header, m), epochSecret, okKey)
        const same = m.every((b, i) => b === plaintext[i])
        if (!same) expect(failureOf(r)).not.toBeNull()
      }),
      { numRuns: 300 },
    )
  })
})
