/**
 * Page envelope seal and open (docs/gateway-protocol.md §12.20, receive steps 3 to 5).
 *
 * K_doc comes from a random 32-byte salt per envelope, so the AES-256-GCM nonce is 12 zero bytes,
 * as for messages. The sender's MLS signature key signs under the label "DocEnvelope".
 */
import type { DocDecryptFailure, DocEnvelopeHeader } from '../api'
import { DOC_SALT_LENGTH, SignLabel } from '../constants'
import { signWithLabel, verifyWithLabel } from '../sign'
import { checkDocBody, decodeDocEnvelope, decodeDocPlaintext, encodeDocContent, encodeDocHeader, encodeDocPlaintext, encodeEnvelope } from './codec'
import { aesGcm, deriveDocKeySync, envelopeSignedContent, randomBytes } from './index'

export interface DocSealInput {
  header: Omit<DocEnvelopeHeader, 'salt'>
  body: Uint8Array
  sentAtMs: number
  epochSecret: Uint8Array
  signatureKey: Uint8Array
}

export interface DocOpenResult<S> {
  header: DocEnvelopeHeader
  body: Uint8Array
  sentAtMs: number
  /** What `senderKey` returned. */
  sender: S
}

/** Seals already-checked parts. `sealDoc` is the normal entry; tests call this to sign other bytes. */
export async function sealDocContentBytes(input: Omit<DocSealInput, 'body' | 'sentAtMs'>, contentBytes: Uint8Array): Promise<Uint8Array> {
  const header: DocEnvelopeHeader = { ...input.header, salt: randomBytes(DOC_SALT_LENGTH) }
  const headerBytes = encodeDocHeader(header)
  const signature = signWithLabel(input.signatureKey, SignLabel.DOC_ENVELOPE, envelopeSignedContent(headerBytes, contentBytes))
  const key = deriveDocKeySync(input.epochSecret, header.salt, header.senderLeaf)
  const ciphertext = await aesGcm('encrypt', key, headerBytes, encodeDocPlaintext(contentBytes, signature))
  return encodeEnvelope(headerBytes, ciphertext)
}

/** Checks the body rules of the kind, then signs and encrypts with a fresh salt (a fresh K_doc). */
export function sealDoc(input: DocSealInput): Promise<Uint8Array> {
  checkDocBody(input.header.kind, input.body)
  return sealDocContentBytes(input, encodeDocContent(input.body, input.sentAtMs))
}

/**
 * §12.20 receive steps 3 to 5. The caller did step 1 (the header against the item) and step 2
 * (S_e). `senderKey` is step 4: the verified MLS signature key of the header's sender, or a failure.
 */
export async function openDoc<S extends { signatureKey: Uint8Array }>(
  bytes: Uint8Array,
  epochSecret: Uint8Array,
  senderKey: (h: DocEnvelopeHeader) => Promise<S | { failure: DocDecryptFailure }>,
): Promise<DocOpenResult<S> | { failure: DocDecryptFailure }> {
  let decoded: ReturnType<typeof decodeDocEnvelope>
  try {
    decoded = decodeDocEnvelope(bytes)
  } catch {
    return { failure: 'malformed' }
  }
  const { header, headerBytes, ciphertext } = decoded

  // Step 3: decrypt, then decode the plaintext and check the body of the kind.
  let plaintext: Uint8Array
  try {
    plaintext = await aesGcm('decrypt', deriveDocKeySync(epochSecret, header.salt, header.senderLeaf), headerBytes, ciphertext)
  } catch {
    return { failure: 'aead' }
  }
  let opened: ReturnType<typeof decodeDocPlaintext>
  try {
    opened = decodeDocPlaintext(plaintext)
    checkDocBody(header.kind, opened.body)
  } catch {
    return { failure: 'malformed' }
  }

  // Step 4: the sender certificate (the caller checks the chain).
  const sender = await senderKey(header)
  if ('failure' in sender) return sender

  // Step 5: the signature.
  if (!verifyWithLabel(sender.signatureKey, SignLabel.DOC_ENVELOPE, envelopeSignedContent(headerBytes, opened.contentBytes), opened.signature)) {
    return { failure: 'bad_signature' }
  }
  return { header, body: opened.body, sentAtMs: opened.sentAtMs, sender }
}
