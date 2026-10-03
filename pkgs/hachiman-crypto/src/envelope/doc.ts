/**
 * Page envelope seal and open (docs/gateway-protocol.md §12.20, receive steps 3 to 5).
 *
 * K_doc comes from a random 32-byte salt per envelope, so the AES-256-GCM nonce is 12 zero bytes,
 * as for messages. The sender's MLS signature key signs under the label "DocEnvelope".
 */
import type { DocDecryptFailure, DocEnvelopeHeader } from '../api'
import { DOC_SALT_LENGTH, SignLabel } from '../constants'
import type { DocPlaintext } from './codec'
import { checkDocBody, decodeDocEnvelope, decodeDocPlaintext, encodeDocContent, encodeDocHeader, encodeDocPlaintext } from './codec'
import type { EnvelopeScheme } from './index'
import { deriveDocKeySync, openWith, randomBytes, sealWith } from './index'

export interface DocSealInput {
  header: Omit<DocEnvelopeHeader, 'salt'>
  body: Uint8Array
  sentAtMs: number
  epochSecret: Uint8Array
  signatureKey: Uint8Array
}

const DOC_SCHEME: EnvelopeScheme<DocEnvelopeHeader, DocPlaintext> = {
  signLabel: SignLabel.DOC_ENVELOPE,
  deriveKey: deriveDocKeySync,
  decodeEnvelope: decodeDocEnvelope,
  decodePlaintext(plaintext, header) {
    const p = decodeDocPlaintext(plaintext)
    checkDocBody(header.kind, p.body)
    return p
  },
}

/** Seals already-checked parts. `sealDoc` is the normal entry; tests call this to sign other bytes. */
export function sealDocContentBytes(input: Omit<DocSealInput, 'body' | 'sentAtMs'>, contentBytes: Uint8Array): Promise<Uint8Array> {
  const header: DocEnvelopeHeader = { ...input.header, salt: randomBytes(DOC_SALT_LENGTH) }
  return sealWith(DOC_SCHEME, input, header, encodeDocHeader(header), contentBytes, (signature) => encodeDocPlaintext(contentBytes, signature))
}

/** Checks the body rules of the kind, then signs and encrypts with a fresh salt (a fresh K_doc). */
export function sealDoc(input: DocSealInput): Promise<Uint8Array> {
  checkDocBody(input.header.kind, input.body)
  return sealDocContentBytes(input, encodeDocContent(input.body, input.sentAtMs))
}

/**
 * §12.20 receive steps 3 to 5. The caller did step 1 (the header against the item) and step 2
 * (S_e). `senderKey` is step 4.
 */
export async function openDoc<S extends { signatureKey: Uint8Array }>(
  bytes: Uint8Array,
  epochSecret: Uint8Array,
  senderKey: (h: DocEnvelopeHeader) => Promise<S | { failure: DocDecryptFailure }>,
): Promise<{ body: Uint8Array; sender: S } | { failure: DocDecryptFailure }> {
  const result = await openWith(DOC_SCHEME, bytes, epochSecret, senderKey)
  if ('failure' in result) return result
  return { body: result.opened.body, sender: result.sender }
}
