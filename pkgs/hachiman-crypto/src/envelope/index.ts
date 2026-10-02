/**
 * Envelope seal and open (docs/gateway-protocol.md §12.8.1, §12.8.2, §12.8.5 steps 3-7).
 *
 * K_msg comes from a random 32-byte salt per message, so the AES-256-GCM nonce is 12 zero
 * bytes. A key is never used twice, so a nonce is never used twice under one key.
 */
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

import type { DecryptFailure, EnvelopeHeader, EnvelopeModule, EnvelopeOpenResult, EnvelopeSealInput } from '../api'
import { CryptoError } from '../api'
import { Writer } from '../codec'
import { EXPORTER_LENGTH, FRANKING_KEY_LENGTH, HkdfInfo, MESSAGE_SALT_LENGTH, SignLabel } from '../constants'
import { frankingTagSync, verifyFrankingSync } from '../franking'
import { signWithLabel, verifyWithLabel } from '../sign'
import type { EnvelopeContent } from './codec'
import { decodeContent, decodeEnvelope, decodePlaintext, encodeContent, encodeEnvelope, encodeHeader, encodePlaintext } from './codec'

const MESSAGE_KEY_INFO = new TextEncoder().encode(HkdfInfo.MESSAGE_KEY)
const ZERO_NONCE = new Uint8Array(12)

/** A copy backed by a plain ArrayBuffer, as WebCrypto's BufferSource type wants. */
function buf(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.length)
  out.set(u)
  return out
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n))
}

export function deriveMessageKeySync(epochSecret: Uint8Array, salt: Uint8Array, senderLeaf: number): Uint8Array {
  if (epochSecret.length !== EXPORTER_LENGTH) throw new CryptoError('Malformed', `S_e must be ${EXPORTER_LENGTH} bytes`)
  if (salt.length !== MESSAGE_SALT_LENGTH) throw new CryptoError('Malformed', `salt must be ${MESSAGE_SALT_LENGTH} bytes`)
  const info = new Writer().fixed(MESSAGE_KEY_INFO, MESSAGE_KEY_INFO.length).u32(senderLeaf).finish()
  return hkdf(sha256, epochSecret, salt, info, 32)
}

/** The bytes that the Envelope signature covers: SHA-256(encode(header)) ‖ SHA-256(encode(content)). */
export function envelopeSignedContent(headerBytes: Uint8Array, contentBytes: Uint8Array): Uint8Array {
  return concat(sha256(headerBytes), sha256(contentBytes))
}

async function aesGcm(mode: 'encrypt' | 'decrypt', key: Uint8Array, aad: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await globalThis.crypto.subtle.importKey('raw', buf(key), 'AES-GCM', false, [mode])
  const params = { name: 'AES-GCM', iv: buf(ZERO_NONCE), additionalData: buf(aad), tagLength: 128 }
  const out = mode === 'encrypt' ? await globalThis.crypto.subtle.encrypt(params, k, buf(data)) : await globalThis.crypto.subtle.decrypt(params, k, buf(data))
  return new Uint8Array(out)
}

/**
 * Seals already-encoded content bytes. `seal` is the normal entry. Tests call this directly to
 * build envelopes that break the kind/edit_of rule, which only receivers check (step 7).
 */
export async function sealContentBytes(input: Omit<EnvelopeSealInput, 'kind' | 'editOf' | 'content' | 'ktTreeHead'>, contentBytes: Uint8Array): Promise<Uint8Array> {
  const salt = randomBytes(MESSAGE_SALT_LENGTH)
  const frankingKey = randomBytes(FRANKING_KEY_LENGTH)
  const frankingTag = frankingTagSync({ frankingKey, channelId: input.header.channelId, clientMsgId: input.header.clientMsgId, content: contentBytes })
  const header: EnvelopeHeader = { ...input.header, salt, frankingTag }
  const headerBytes = encodeHeader(header)
  const signature = signWithLabel(input.signatureKey, SignLabel.ENVELOPE, envelopeSignedContent(headerBytes, contentBytes))
  const plaintext = encodePlaintext(contentBytes, frankingKey, signature)
  const key = deriveMessageKeySync(input.epochSecret, salt, header.senderLeaf)
  const ciphertext = await aesGcm('encrypt', key, headerBytes, plaintext)
  return encodeEnvelope(headerBytes, ciphertext)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export const envelope: EnvelopeModule = {
  encodeHeader,

  decodeHeader(bytes) {
    const { header, headerBytes } = decodeEnvelope(bytes)
    return { header, headerBytes }
  },

  deriveMessageKey(epochSecret, salt, senderLeaf) {
    try {
      return Promise.resolve(deriveMessageKeySync(epochSecret, salt, senderLeaf))
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)))
    }
  },

  async seal(input) {
    if (input.kind === 'edit') {
      if (input.editOf === null || !sameBytes(input.editOf, input.header.clientMsgId)) {
        throw new CryptoError('Malformed', 'an edit keeps the client_msg_id of the original, and edit_of repeats it')
      }
    }
    const content: EnvelopeContent = { kind: input.kind, editOf: input.editOf, content: input.content, ktTreeHead: input.ktTreeHead }
    return sealContentBytes(input, encodeContent(content))
  },

  async open(bytes, epochSecret, senderKey): Promise<EnvelopeOpenResult | { failure: DecryptFailure }> {
    let decoded: ReturnType<typeof decodeEnvelope>
    try {
      decoded = decodeEnvelope(bytes)
    } catch {
      return { failure: 'malformed' }
    }
    const { header, headerBytes, ciphertext } = decoded

    // Step 3: decrypt, then decode the plaintext.
    let plaintext: Uint8Array
    try {
      const key = deriveMessageKeySync(epochSecret, header.salt, header.senderLeaf)
      plaintext = await aesGcm('decrypt', key, headerBytes, ciphertext)
    } catch {
      return { failure: 'aead' }
    }
    let opened: ReturnType<typeof decodePlaintext>
    try {
      opened = decodePlaintext(plaintext)
    } catch {
      return { failure: 'malformed' }
    }

    // Step 4: the sender certificate (the caller checks the chain and the author).
    const sender = await senderKey(header, opened.kind)
    if ('failure' in sender) return { failure: sender.failure }

    // Step 5: the signature.
    if (!verifyWithLabel(sender.signatureKey, SignLabel.ENVELOPE, envelopeSignedContent(headerBytes, opened.contentBytes), opened.signature)) {
      return { failure: 'bad_signature' }
    }

    // Step 6: franking.
    const frankingOk = verifyFrankingSync({
      frankingTag: header.frankingTag,
      frankingKey: opened.frankingKey,
      channelId: header.channelId,
      clientMsgId: header.clientMsgId,
      content: opened.contentBytes,
    })
    if (!frankingOk) return { failure: 'bad_franking' }

    // Step 7: kind 1 has no edit_of; kind 2 has edit_of = header client_msg_id.
    if (opened.kind === 'message' ? opened.editOf !== null : opened.editOf === null || !sameBytes(opened.editOf, header.clientMsgId)) {
      return { failure: 'malformed' }
    }

    return {
      header,
      kind: opened.kind,
      editOf: opened.editOf,
      content: opened.content,
      frankingKey: opened.frankingKey,
      ktTreeHead: opened.ktTreeHead,
      contentBytes: opened.contentBytes,
    }
  },

  encodeContent(kind, editOf, content, ktTreeHead) {
    return encodeContent({ kind, editOf, content, ktTreeHead })
  },

  decodeContent(b) {
    return decodeContent(b)
  },
}
