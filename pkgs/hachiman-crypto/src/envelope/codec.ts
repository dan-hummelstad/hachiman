/**
 * Envelope codecs (docs/gateway-protocol.md §12.8.1). Encoders reject values that break a
 * §12.8.1 limit. Decoders reject every violation and trailing bytes, with CryptoError('Malformed').
 *
 * This file imports no WebCrypto and no store code: Takusen (`@hachiman/crypto/ds`) can use the
 * header codec.
 */
import type {
  AttachmentPointer,
  DocEnvelopeHeader,
  DocEnvelopeKindName,
  DocSnapshotPointer,
  EnvelopeHeader,
  EnvelopeKindName,
  KindedContent,
  Mention,
  MentionKind,
  MessageContent,
  ThumbnailPointer,
} from '../api'
import { CryptoError } from '../api'
import { Reader, Writer, bytesToUuid, fromB64url, toB64url, uuidToBytes } from '../codec'
import {
  CLIENT_MSG_ID_LENGTH,
  DOC_ENVELOPE_MAGIC,
  DOC_SALT_LENGTH,
  DocEnvelopeKind,
  ENVELOPE_MAGIC,
  EnvelopeKind,
  FRANKING_KEY_LENGTH,
  FRANKING_TAG_LENGTH,
  GROUP_ID_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_UPLOAD_IDS,
  MAX_PAGE_ACTIVITY_CHANGES,
  MAX_PAGE_BANNER_BYTES,
  MAX_PAGE_TITLE_BYTES,
  MAX_REACTION_EMOJI_BYTES,
  MAX_REACTION_EMOJI_LENGTH,
  MAX_TEXT_BYTES,
  MESSAGE_SALT_LENGTH,
  MentionType,
} from '../constants'

// MARK: - Limits of §12.8.1

export const MAX_MENTIONS = 100
export const MAX_MIME_BYTES = 127
export const MAX_NAME_BYTES = 255
export const MAX_BLURHASH_BYTES = 100
export const FILE_KEY_LENGTH = 32
export const SHA256_LENGTH = 32
/** Ed25519 signature bytes. */
export const SIGNATURE_LENGTH = 64

/** Lowercase `type/subtype` (RFC 6838 restricted-name characters), no parameters. */
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/
/** Printable ASCII. */
const BLURHASH_RE = /^[\x20-\x7e]+$/

export type { EnvelopeKindName }

/** The decoded `Envelope` struct, or a `DocEnvelope` with H = DocEnvelopeHeader. */
export interface Envelope<H = EnvelopeHeader> {
  header: H
  /** encode(header): the AEAD additional data and the signed header bytes. */
  headerBytes: Uint8Array
  ciphertext: Uint8Array
}

/** The decoded `EnvelopeContent` struct. */
export type EnvelopeContent = KindedContent<Uint8Array> & { ktTreeHead: Uint8Array | null }

/** The decoded `EnvelopePlaintext` struct. */
export type EnvelopePlaintext = EnvelopeContent & {
  /** The exact encode(EnvelopeContent) bytes from the plaintext (signed and franked). */
  contentBytes: Uint8Array
  frankingKey: Uint8Array
  signature: Uint8Array
}

function malformed(message: string): never {
  throw new CryptoError('Malformed', message)
}

function tooLarge(message: string): never {
  throw new CryptoError('TooLarge', message)
}

/** Runs a decoder and maps every error to CryptoError('Malformed'). */
function decoding<T>(what: string, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof CryptoError && e.code === 'Malformed') throw e
    throw new CryptoError('Malformed', `${what}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Runs an encoder and maps codec errors (bad UUIDs, out-of-range integers) to CryptoError('Malformed'). */
function encoding<T>(what: string, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof CryptoError) throw e
    throw new CryptoError('Malformed', `${what}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function bytesOf(b64: string, length: number, what: string): Uint8Array {
  let out: Uint8Array
  try {
    out = fromB64url(b64)
  } catch {
    malformed(`${what} is not base64url`)
  }
  if (out.length !== length) malformed(`${what} must be ${length} bytes`)
  return out
}

function checkLength(bytes: Uint8Array, length: number, what: string): void {
  if (bytes.length !== length) malformed(`${what} must be ${length} bytes`)
}

function checkMime(mime: string): void {
  const n = utf8Bytes(mime).length
  if (n > MAX_MIME_BYTES) tooLarge(`mime longer than ${MAX_MIME_BYTES} bytes`)
  if (!MIME_RE.test(mime)) malformed('mime is not a lowercase type/subtype')
}

function checkSize(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) malformed(`${what} must be a non-negative safe integer`)
}

function checkU32(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) malformed(`${what} must be a uint32`)
}

/** 0 on the wire means "none". */
function optionalU32(n: number | null, what: string): number {
  if (n === null) return 0
  checkU32(n, what)
  return n
}

// MARK: - EnvelopeHeader and Envelope

function writeHeader(w: Writer, h: EnvelopeHeader): void {
  checkLength(h.groupId, GROUP_ID_LENGTH, 'group_id')
  checkLength(h.clientMsgId, CLIENT_MSG_ID_LENGTH, 'client_msg_id')
  checkLength(h.salt, MESSAGE_SALT_LENGTH, 'salt')
  checkLength(h.frankingTag, FRANKING_TAG_LENGTH, 'franking_tag')
  checkSize(h.epoch, 'epoch')
  checkU32(h.senderLeaf, 'sender_leaf')
  w.u16(ENVELOPE_MAGIC)
    .opaque(h.groupId)
    .fixed(uuidToBytes(h.channelId), 16)
    .u64(h.epoch)
    .u32(h.senderLeaf)
    .fixed(uuidToBytes(h.senderDeviceId), 16)
    .fixed(h.clientMsgId, CLIENT_MSG_ID_LENGTH)
    .fixed(h.salt, MESSAGE_SALT_LENGTH)
    .fixed(h.frankingTag, FRANKING_TAG_LENGTH)
}

function readHeader(r: Reader): EnvelopeHeader {
  if (r.u16() !== ENVELOPE_MAGIC) malformed('bad envelope magic')
  const groupId = r.opaque(GROUP_ID_LENGTH)
  checkLength(groupId, GROUP_ID_LENGTH, 'group_id')
  const channelId = bytesToUuid(r.fixed(16))
  const epoch = r.u64n()
  const senderLeaf = r.u32()
  const senderDeviceId = bytesToUuid(r.fixed(16))
  const clientMsgId = r.fixed(CLIENT_MSG_ID_LENGTH)
  const salt = r.fixed(MESSAGE_SALT_LENGTH)
  const frankingTag = r.fixed(FRANKING_TAG_LENGTH)
  return { groupId, channelId, epoch, senderLeaf, senderDeviceId, clientMsgId, salt, frankingTag }
}

export function encodeHeader(h: EnvelopeHeader): Uint8Array {
  return encoding('EnvelopeHeader', () => {
    const w = new Writer()
    writeHeader(w, h)
    return w.finish()
  })
}

export function encodeEnvelope(headerBytes: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return new Writer().fixed(headerBytes, headerBytes.length).opaque(ciphertext).finish()
}

function decodeWhole<H>(what: string, envelope: Uint8Array, read: (r: Reader) => H): Envelope<H> {
  return decoding(what, () => {
    const r = new Reader(envelope)
    const header = read(r)
    const headerBytes = envelope.slice(0, envelope.length - r.remaining)
    const ciphertext = r.opaque()
    r.end()
    return { header, headerBytes, ciphertext }
  })
}

/** Decodes a whole Envelope (header and ciphertext, no trailing bytes). */
export function decodeEnvelope(envelope: Uint8Array): Envelope {
  return decodeWhole('Envelope', envelope, readHeader)
}

// MARK: - Mention

const MENTION_TYPE: Record<MentionKind, number> = { user: MentionType.USER, role: MentionType.ROLE, everyone: MentionType.EVERYONE }
const ZERO_ID = new Uint8Array(16)

function writeMention(w: Writer, m: Mention): void {
  const type = MENTION_TYPE[m.type] as number | undefined
  if (type === undefined) malformed('unknown mention type')
  if (m.type === 'everyone') {
    if (m.id !== null) malformed('an everyone mention has no id')
    w.u8(type).fixed(ZERO_ID, 16)
    return
  }
  if (m.id === null) malformed('a user or role mention needs an id')
  w.u8(type).fixed(uuidToBytes(m.id), 16)
}

function readMention(r: Reader): Mention {
  const type = r.u8()
  const id = r.fixed(16)
  if (type === MentionType.EVERYONE) {
    if (id.some((b) => b !== 0)) malformed('an everyone mention must have a zero id')
    return { type: 'everyone', id: null }
  }
  if (type === MentionType.USER) return { type: 'user', id: bytesToUuid(id) }
  if (type === MentionType.ROLE) return { type: 'role', id: bytesToUuid(id) }
  return malformed(`unknown mention type ${type}`)
}

// MARK: - ThumbnailPointer and AttachmentPointer

function writeThumbnail(w: Writer, t: ThumbnailPointer): void {
  checkSize(t.size, 'thumbnail size')
  checkSize(t.blobSize, 'thumbnail blob_size')
  checkMime(t.mime)
  checkU32(t.width, 'thumbnail width')
  checkU32(t.height, 'thumbnail height')
  w.fixed(uuidToBytes(t.uploadId), 16)
    .fixed(bytesOf(t.key, FILE_KEY_LENGTH, 'thumbnail key'), FILE_KEY_LENGTH)
    .fixed(bytesOf(t.sha256, SHA256_LENGTH, 'thumbnail sha256'), SHA256_LENGTH)
    .u64(t.size)
    .u64(t.blobSize)
    .utf8(t.mime)
    .u32(t.width)
    .u32(t.height)
}

function readMime(r: Reader): string {
  const mime = r.utf8(MAX_MIME_BYTES)
  if (!MIME_RE.test(mime)) malformed('mime is not a lowercase type/subtype')
  return mime
}

function readThumbnail(r: Reader): ThumbnailPointer {
  const uploadId = bytesToUuid(r.fixed(16))
  const key = toB64url(r.fixed(FILE_KEY_LENGTH))
  const sha256 = toB64url(r.fixed(SHA256_LENGTH))
  const size = r.u64n()
  const blobSize = r.u64n()
  const mime = readMime(r)
  const width = r.u32()
  const height = r.u32()
  return { uploadId, key, sha256, size, blobSize, mime, width, height }
}

function writePointer(w: Writer, p: AttachmentPointer): void {
  checkSize(p.size, 'size')
  checkSize(p.blobSize, 'blob_size')
  checkMime(p.mime)
  const name = utf8Bytes(p.name)
  if (name.length > MAX_NAME_BYTES) tooLarge(`name longer than ${MAX_NAME_BYTES} bytes`)
  if (name.length === 0) malformed('name is empty')
  if (p.blurhash !== null) {
    if (p.blurhash.length > MAX_BLURHASH_BYTES) tooLarge(`blurhash longer than ${MAX_BLURHASH_BYTES} bytes`)
    if (!BLURHASH_RE.test(p.blurhash)) malformed('blurhash must be 1 to 100 printable ASCII bytes')
  }
  w.fixed(uuidToBytes(p.uploadId), 16)
    .fixed(bytesOf(p.key, FILE_KEY_LENGTH, 'key'), FILE_KEY_LENGTH)
    .fixed(bytesOf(p.sha256, SHA256_LENGTH, 'sha256'), SHA256_LENGTH)
    .u64(p.size)
    .u64(p.blobSize)
    .utf8(p.mime)
    .opaque(name)
    .u32(optionalU32(p.width, 'width'))
    .u32(optionalU32(p.height, 'height'))
    .u32(optionalU32(p.durationMs, 'duration_ms'))
    .optional(p.blurhash, (w2, s) => w2.utf8(s))
    .optional(p.thumbnail, writeThumbnail)
}

function readPointer(r: Reader): AttachmentPointer {
  const uploadId = bytesToUuid(r.fixed(16))
  const key = toB64url(r.fixed(FILE_KEY_LENGTH))
  const sha256 = toB64url(r.fixed(SHA256_LENGTH))
  const size = r.u64n()
  const blobSize = r.u64n()
  const mime = readMime(r)
  const name = r.utf8(MAX_NAME_BYTES)
  if (name.length === 0) malformed('name is empty')
  const width = r.u32()
  const height = r.u32()
  const durationMs = r.u32()
  const blurhash = r.optional((r2) => {
    const s = r2.utf8(MAX_BLURHASH_BYTES)
    if (!BLURHASH_RE.test(s)) malformed('blurhash must be 1 to 100 printable ASCII bytes')
    return s
  })
  const thumbnail = r.optional(readThumbnail)
  return {
    uploadId,
    key,
    sha256,
    size,
    blobSize,
    mime,
    name,
    width: width === 0 ? null : width,
    height: height === 0 ? null : height,
    durationMs: durationMs === 0 ? null : durationMs,
    blurhash,
    thumbnail,
  }
}

/** The upload ids of a pointer list in message order: each file id, then its thumbnail id (§12.8.5 step 8). */
export function uploadIdsOf(attachments: readonly AttachmentPointer[]): { id: string; blobSize: number }[] {
  const out: { id: string; blobSize: number }[] = []
  for (const p of attachments) {
    out.push({ id: p.uploadId, blobSize: p.blobSize })
    if (p.thumbnail !== null) out.push({ id: p.thumbnail.uploadId, blobSize: p.thumbnail.blobSize })
  }
  return out
}

// MARK: - EnvelopeContent

function checkContentLimits(content: Pick<MessageContent, 'text' | 'mentions' | 'attachments'>, textBytes: number): void {
  if (textBytes > MAX_TEXT_BYTES) tooLarge(`text longer than ${MAX_TEXT_BYTES} bytes`)
  if (content.mentions.length > MAX_MENTIONS) tooLarge(`more than ${MAX_MENTIONS} mentions`)
  if (content.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) tooLarge(`more than ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`)
  if (uploadIdsOf(content.attachments).length > MAX_MESSAGE_UPLOAD_IDS) tooLarge(`more than ${MAX_MESSAGE_UPLOAD_IDS} upload ids`)
  if (textBytes === 0 && content.attachments.length === 0) malformed('a message needs text or an attachment')
}

const KIND_BYTE: Record<EnvelopeKindName, number> = {
  message: EnvelopeKind.MESSAGE,
  edit: EnvelopeKind.EDIT,
  reaction: EnvelopeKind.REACTION,
  page_activity: EnvelopeKind.PAGE_ACTIVITY,
}

/** Control characters (Cc) and lone surrogates (Cs). */
const EMOJI_FORBIDDEN_RE = /[\p{Cc}\p{Cs}]/u

function checkEmoji(emoji: string): void {
  if (emoji.length === 0) malformed('reaction emoji is empty')
  if (emoji.length > MAX_REACTION_EMOJI_LENGTH) tooLarge(`reaction emoji longer than ${MAX_REACTION_EMOJI_LENGTH} UTF-16 units`)
  if (EMOJI_FORBIDDEN_RE.test(emoji)) malformed('reaction emoji has a control character or a lone surrogate')
}

function checkChanges(changes: number): void {
  if (!Number.isInteger(changes) || changes < 1 || changes > MAX_PAGE_ACTIVITY_CHANGES) malformed(`page_activity changes must be 1 to ${MAX_PAGE_ACTIVITY_CHANGES}`)
}

function writeMessageBody(w: Writer, editOf: Uint8Array | null, content: MessageContent): void {
  const text = utf8Bytes(content.text)
  checkContentLimits(content, text.length)
  if (editOf !== null) checkLength(editOf, CLIENT_MSG_ID_LENGTH, 'edit_of')
  const replyTo = content.replyTo === null ? null : bytesOf(content.replyTo, CLIENT_MSG_ID_LENGTH, 'reply_to')
  w.optional(editOf, (w2, v) => w2.fixed(v, CLIENT_MSG_ID_LENGTH))
    .opaque(text)
    .vector(content.mentions, writeMention)
    .vector(content.attachments, writePointer)
    .optional(replyTo, (w2, v) => w2.fixed(v, CLIENT_MSG_ID_LENGTH))
}

function writeContent(w: Writer, c: EnvelopeContent, checkKind: boolean): void {
  const kind = KIND_BYTE[c.kind] as number | undefined
  if (kind === undefined) malformed('unknown envelope kind')
  if (checkKind) {
    if (c.kind === 'message' && c.editOf !== null) malformed('kind message has no edit_of')
    if (c.kind === 'edit' && c.editOf === null) malformed('kind edit needs edit_of')
  }
  checkSize(c.content.sentAtMs, 'sent_at_ms')
  w.u8(kind)
  switch (c.kind) {
    case 'message':
    case 'edit':
      writeMessageBody(w, c.editOf, c.content)
      break
    case 'reaction':
      if (c.editOf !== null) malformed('kind reaction has no edit_of')
      checkEmoji(c.content.emoji)
      w.fixed(bytesOf(c.content.target, CLIENT_MSG_ID_LENGTH, 'target'), CLIENT_MSG_ID_LENGTH)
        .utf8(c.content.emoji)
        .u8(c.content.remove ? 1 : 0)
      break
    case 'page_activity':
      if (c.editOf !== null) malformed('kind page_activity has no edit_of')
      checkChanges(c.content.changes)
      w.fixed(uuidToBytes(c.content.pageId), 16).u32(c.content.changes)
      break
  }
  w.u64(c.content.sentAtMs).optional(c.ktTreeHead, (w2, v) => w2.opaque(v))
}

function readMessageBody(r: Reader): { editOf: Uint8Array | null; content: Omit<MessageContent, 'sentAtMs'> } {
  const editOf = r.optional((r2) => r2.fixed(CLIENT_MSG_ID_LENGTH))
  const text = r.utf8(MAX_TEXT_BYTES)
  const mentions = r.vector(readMention, MAX_MENTIONS)
  const attachments = r.vector(readPointer, MAX_ATTACHMENTS_PER_MESSAGE)
  const replyTo = r.optional((r2) => toB64url(r2.fixed(CLIENT_MSG_ID_LENGTH)))
  const content = { text, mentions, attachments, replyTo }
  checkContentLimits(content, utf8Bytes(text).length)
  return { editOf, content }
}

/** Kinds 3 and 4 have no edit_of on the wire. An unknown kind byte is 'malformed'. */
function readContent(r: Reader): EnvelopeContent {
  const kindByte = r.u8()
  switch (kindByte) {
    case EnvelopeKind.MESSAGE:
    case EnvelopeKind.EDIT: {
      const { editOf, content } = readMessageBody(r)
      const sentAtMs = r.u64n()
      const ktTreeHead = r.optional((r2) => r2.opaque())
      return { kind: kindByte === EnvelopeKind.MESSAGE ? 'message' : 'edit', editOf, content: { ...content, sentAtMs }, ktTreeHead }
    }
    case EnvelopeKind.REACTION: {
      const target = toB64url(r.fixed(CLIENT_MSG_ID_LENGTH))
      const emoji = r.utf8(MAX_REACTION_EMOJI_BYTES)
      checkEmoji(emoji)
      const removeByte = r.u8()
      if (removeByte > 1) malformed('reaction remove must be 0 or 1')
      const sentAtMs = r.u64n()
      const ktTreeHead = r.optional((r2) => r2.opaque())
      return { kind: 'reaction', editOf: null, content: { target, emoji, remove: removeByte === 1, sentAtMs }, ktTreeHead }
    }
    case EnvelopeKind.PAGE_ACTIVITY: {
      const pageId = bytesToUuid(r.fixed(16))
      const changes = r.u32()
      checkChanges(changes)
      const sentAtMs = r.u64n()
      const ktTreeHead = r.optional((r2) => r2.opaque())
      return { kind: 'page_activity', editOf: null, content: { pageId, changes, sentAtMs }, ktTreeHead }
    }
    default:
      return malformed(`unknown envelope kind ${kindByte}`)
  }
}

/** The attachment pointers of a content: none for kinds 3 and 4. */
export function attachmentsOf(c: KindedContent<unknown>): readonly AttachmentPointer[] {
  return c.kind === 'message' || c.kind === 'edit' ? c.content.attachments : []
}

/** Rejects a kind/edit_of mismatch. */
export function encodeContent(c: EnvelopeContent): Uint8Array {
  return encoding('EnvelopeContent', () => {
    const w = new Writer()
    writeContent(w, c, true)
    return w.finish()
  })
}

/**
 * Like encodeContent, but keeps a kind/edit_of mismatch. Receivers check that rule last
 * (§12.8.5 step 7), so tests need envelopes that break it.
 */
export function encodeContentUnchecked(c: EnvelopeContent): Uint8Array {
  return encoding('EnvelopeContent', () => {
    const w = new Writer()
    writeContent(w, c, false)
    return w.finish()
  })
}

/** Accepts a kind/edit_of mismatch: EnvelopeModule.open checks it at step 7. */
export function decodeContent(b: Uint8Array): EnvelopeContent {
  return decoding('EnvelopeContent', () => {
    const r = new Reader(b)
    const c = readContent(r)
    r.end()
    return c
  })
}

// MARK: - EnvelopePlaintext

export function encodePlaintext(contentBytes: Uint8Array, frankingKey: Uint8Array, signature: Uint8Array): Uint8Array {
  return encoding('EnvelopePlaintext', () => {
    checkLength(frankingKey, FRANKING_KEY_LENGTH, 'franking_key')
    return new Writer().fixed(contentBytes, contentBytes.length).fixed(frankingKey, FRANKING_KEY_LENGTH).opaque(signature).finish()
  })
}

/** The trailing `opaque signature<V>` of a plaintext: exactly SIGNATURE_LENGTH bytes, then the end. */
function readFinalSignature(r: Reader): Uint8Array {
  const signature = r.opaque(SIGNATURE_LENGTH)
  if (signature.length !== SIGNATURE_LENGTH) malformed(`signature must be ${SIGNATURE_LENGTH} bytes`)
  r.end()
  return signature
}

export function decodePlaintext(b: Uint8Array): EnvelopePlaintext {
  return decoding('EnvelopePlaintext', () => {
    const r = new Reader(b)
    const content = readContent(r)
    const contentBytes = b.slice(0, b.length - r.remaining)
    const frankingKey = r.fixed(FRANKING_KEY_LENGTH)
    return { ...content, contentBytes, frankingKey, signature: readFinalSignature(r) }
  })
}

// MARK: - Sizes

/** Bytes of a minimal RFC 9420 varint for n. */
function varintLength(n: number): number {
  return n < 0x40 ? 1 : n < 0x4000 ? 2 : 4
}

/** Bytes of encode(EnvelopeHeader): every field is fixed width. */
export const HEADER_LENGTH = 2 + varintLength(GROUP_ID_LENGTH) + GROUP_ID_LENGTH + 16 + 8 + 4 + 16 + CLIENT_MSG_ID_LENGTH + MESSAGE_SALT_LENGTH + FRANKING_TAG_LENGTH

/** The exact Envelope size for a content of `contentLength` bytes (AES-GCM adds a 16-byte tag). */
export function envelopeLength(contentLength: number): number {
  const plaintext = contentLength + FRANKING_KEY_LENGTH + varintLength(SIGNATURE_LENGTH) + SIGNATURE_LENGTH
  const ciphertext = plaintext + 16
  return HEADER_LENGTH + varintLength(ciphertext) + ciphertext
}

// MARK: - Page envelopes (§12.20)

const DOC_KIND: Record<DocEnvelopeKindName, number> = {
  doc_update: DocEnvelopeKind.UPDATE,
  doc_snapshot: DocEnvelopeKind.SNAPSHOT,
  doc_awareness: DocEnvelopeKind.AWARENESS,
  doc_title: DocEnvelopeKind.TITLE,
  doc_banner: DocEnvelopeKind.BANNER,
}
const DOC_KIND_NAME = new Map<number, DocEnvelopeKindName>(Object.entries(DOC_KIND).map(([k, v]) => [v, k as DocEnvelopeKindName]))

/** The decoded `DocPlaintext` struct. */
export interface DocPlaintext {
  body: Uint8Array
  sentAtMs: number
  /** The exact encode(DocContent) bytes (signed). */
  contentBytes: Uint8Array
  signature: Uint8Array
}

function writeDocHeader(w: Writer, h: DocEnvelopeHeader): void {
  const kind = DOC_KIND[h.kind] as number | undefined
  if (kind === undefined) malformed('unknown doc envelope kind')
  checkLength(h.groupId, GROUP_ID_LENGTH, 'group_id')
  checkLength(h.salt, DOC_SALT_LENGTH, 'salt')
  checkSize(h.epoch, 'epoch')
  checkU32(h.senderLeaf, 'sender_leaf')
  w.u16(DOC_ENVELOPE_MAGIC)
    .u8(kind)
    .opaque(h.groupId)
    .fixed(uuidToBytes(h.channelId), 16)
    .fixed(uuidToBytes(h.pageId), 16)
    .u64(h.epoch)
    .u32(h.senderLeaf)
    .fixed(uuidToBytes(h.senderDeviceId), 16)
    .fixed(h.salt, DOC_SALT_LENGTH)
}

function readDocHeader(r: Reader): DocEnvelopeHeader {
  if (r.u16() !== DOC_ENVELOPE_MAGIC) malformed('bad doc envelope magic')
  const kindByte = r.u8()
  const kind = DOC_KIND_NAME.get(kindByte)
  if (kind === undefined) malformed(`unknown doc envelope kind ${kindByte}`)
  const groupId = r.opaque(GROUP_ID_LENGTH)
  checkLength(groupId, GROUP_ID_LENGTH, 'group_id')
  const channelId = bytesToUuid(r.fixed(16))
  const pageId = bytesToUuid(r.fixed(16))
  const epoch = r.u64n()
  const senderLeaf = r.u32()
  const senderDeviceId = bytesToUuid(r.fixed(16))
  const salt = r.fixed(DOC_SALT_LENGTH)
  return { kind, groupId, channelId, pageId, epoch, senderLeaf, senderDeviceId, salt }
}

export function encodeDocHeader(h: DocEnvelopeHeader): Uint8Array {
  return encoding('DocEnvelopeHeader', () => {
    const w = new Writer()
    writeDocHeader(w, h)
    return w.finish()
  })
}

/** Decodes a whole DocEnvelope (header and ciphertext, no trailing bytes). */
export function decodeDocEnvelope(envelope: Uint8Array): Envelope<DocEnvelopeHeader> {
  return decodeWhole('DocEnvelope', envelope, readDocHeader)
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true })
const SNAPSHOT_POINTER_KEYS = ['fileKey', 'sha256', 'size', 'uploadId']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The doc_snapshot body: strict UTF-8 JSON of exactly the four pointer fields. */
export function decodeSnapshotPointer(body: Uint8Array): DocSnapshotPointer {
  return decoding('DocSnapshotPointer', () => {
    const v: unknown = JSON.parse(STRICT_UTF8.decode(body))
    if (typeof v !== 'object' || v === null || Array.isArray(v)) malformed('snapshot pointer is not an object')
    const o = v as Record<string, unknown>
    if (Object.keys(o).sort().join() !== SNAPSHOT_POINTER_KEYS.join()) malformed('snapshot pointer needs exactly uploadId, fileKey, sha256 and size')
    const { uploadId, fileKey, sha256, size } = o
    if (typeof uploadId !== 'string' || !UUID_RE.test(uploadId)) malformed('uploadId is not a lowercase UUID')
    if (typeof fileKey !== 'string' || typeof sha256 !== 'string' || typeof size !== 'number') malformed('snapshot pointer field types')
    bytesOf(fileKey, FILE_KEY_LENGTH, 'fileKey')
    bytesOf(sha256, SHA256_LENGTH, 'sha256')
    checkSize(size, 'size')
    return { uploadId, fileKey, sha256, size }
  })
}

/** The body rules of §12.20 per kind. doc_update and doc_awareness bodies are opaque to the Worker. */
export function checkDocBody(kind: DocEnvelopeKindName, body: Uint8Array): void {
  if (kind === 'doc_title') {
    if (body.length === 0) malformed('a page title is empty')
    if (body.length > MAX_PAGE_TITLE_BYTES) tooLarge(`page title longer than ${MAX_PAGE_TITLE_BYTES} bytes`)
    decoding('page title', () => STRICT_UTF8.decode(body))
  } else if (kind === 'doc_snapshot') {
    decodeSnapshotPointer(body)
  } else if (kind === 'doc_banner') {
    checkBannerBody(body)
  }
}

/**
 * The doc_banner body: strict UTF-8 JSON of an object whose `mime` starts with `image/`. Unknown
 * keys pass. The UI checks the whole AttachmentPointer and fails closed.
 */
function checkBannerBody(body: Uint8Array): void {
  if (body.length > MAX_PAGE_BANNER_BYTES) tooLarge(`page banner pointer longer than ${MAX_PAGE_BANNER_BYTES} bytes`)
  decoding('page banner pointer', () => {
    const v: unknown = JSON.parse(STRICT_UTF8.decode(body))
    if (typeof v !== 'object' || v === null || Array.isArray(v)) malformed('banner pointer is not an object')
    const { mime } = v as Record<string, unknown>
    if (typeof mime !== 'string' || !mime.startsWith('image/')) malformed('banner mime is not an image type')
  })
}

export function encodeDocContent(body: Uint8Array, sentAtMs: number): Uint8Array {
  return encoding('DocContent', () => {
    checkSize(sentAtMs, 'sent_at_ms')
    return new Writer().opaque(body).u64(sentAtMs).finish()
  })
}

export function encodeDocPlaintext(contentBytes: Uint8Array, signature: Uint8Array): Uint8Array {
  return new Writer().fixed(contentBytes, contentBytes.length).opaque(signature).finish()
}

export function decodeDocPlaintext(b: Uint8Array): DocPlaintext {
  return decoding('DocPlaintext', () => {
    const r = new Reader(b)
    const body = r.opaque()
    const sentAtMs = r.u64n()
    const contentBytes = b.slice(0, b.length - r.remaining)
    return { body, sentAtMs, contentBytes, signature: readFinalSignature(r) }
  })
}

/** Bytes of encode(DocEnvelopeHeader): every field is fixed width. */
export const DOC_HEADER_LENGTH = 2 + 1 + varintLength(GROUP_ID_LENGTH) + GROUP_ID_LENGTH + 16 + 16 + 8 + 4 + 16 + DOC_SALT_LENGTH

/** The exact DocEnvelope size for a body of `bodyLength` bytes. */
export function docEnvelopeLength(bodyLength: number): number {
  const content = varintLength(bodyLength) + bodyLength + 8
  const ciphertext = content + varintLength(SIGNATURE_LENGTH) + SIGNATURE_LENGTH + 16
  return DOC_HEADER_LENGTH + varintLength(ciphertext) + ciphertext
}
