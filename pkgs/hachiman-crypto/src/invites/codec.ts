/**
 * Byte layouts of invites with history (docs/gateway-protocol.md §12.11.4). Pure: `mls/ds.ts`
 * (Node) imports this file through record.ts. Every encoder is deterministic and checks what the
 * decoder checks, so an encoded value always decodes. Every decoder rejects trailing bytes,
 * unknown versions, wrong sizes, channel ids out of order and epochs out of order. Decoders do
 * not verify signatures: see record.ts.
 */
import type { ChannelId, DeviceId, GuildId, InviteRecordView, UserId } from '../api'
import { CodecError, Reader, Writer, bytesToUuid, decode, encode, toB64url, uuidToBytes } from '../codec'
import { HISTORY_BUNDLE_MAX_EPOCHS, INVITE_BUNDLE_MAX_BYTES, INVITE_MAX_SCOPE_CHANNELS, INVITE_WIRE_VERSION } from '../constants'
import { compareBytes } from '../identity/bytes'
import { type HistoryKey, readHistoryKey, writeHistoryKey } from '../identity/codec'

const KEY = 32
const SIG = 64
/** Room for a group id (22 bytes) and future formats, never unbounded (as identity/codec.ts). */
const MAX_GROUP_ID = 64
/** version, guild, two keys, the channel vector (2-byte prefix), seq, expiry, uses, creator ids. */
const MAX_RECORD_BYTES = 1 + 16 + KEY + KEY + 2 + INVITE_MAX_SCOPE_CHANNELS * 16 + 8 + 8 + 4 + 16 + 16
/** Both fields have a 2-byte length prefix (64 and above need 2 bytes). */
const MAX_SIGNED_RECORD_BYTES = 2 + MAX_RECORD_BYTES + 2 + SIG

/** struct InviteRecord. `signPublic` is the invite key id. */
export interface InviteRecord {
  guildId: GuildId
  hpkePublic: Uint8Array
  signPublic: Uint8Array
  /** Strictly ascending in byte order, at most INVITE_MAX_SCOPE_CHANNELS. */
  channelIds: ChannelId[]
  adminChainSeq: number
  /** 0 = permanent. */
  expiresAtMs: number
  /** 0 = no limit. */
  maxUses: number
  creatorUserId: UserId
  creatorDeviceId: DeviceId
}

/** struct { opaque record<V>; opaque signature<V>; } SignedInviteRecord. `record` is an encoded InviteRecord. */
export interface SignedInviteRecord {
  record: Uint8Array
  signature: Uint8Array
}

/** struct InviteBundleTBS: what the sender device signs. */
export interface InviteBundleTbs {
  signPublic: Uint8Array
  groupId: Uint8Array
  /** Strictly ascending epochs, 1 to HISTORY_BUNDLE_MAX_EPOCHS keys. */
  keys: HistoryKey[]
  senderUserId: UserId
  senderDeviceId: DeviceId
}

/** struct { opaque tbs<V>; opaque signature<V>; } InviteBundleContent: the HPKE plaintext. */
export interface InviteBundleContent {
  tbs: Uint8Array
  signature: Uint8Array
}

/** struct { uint8 version; opaque enc[32]; opaque ciphertext<V>; } InviteBundle. */
export interface InviteBundle {
  enc: Uint8Array
  ciphertext: Uint8Array
}

/** struct { uint8 version; opaque signed_record<V>; opaque signature<V>; } InviteAuth. */
export interface InviteAuth {
  signedRecord: Uint8Array
  signature: Uint8Array
}

function version(r: Reader): void {
  const v = r.u8()
  if (v !== INVITE_WIRE_VERSION) throw new CodecError(`unsupported version ${v}`)
}

const uuid = (w: Writer, id: string): Writer => w.fixed(uuidToBytes(id), 16)
const readUuid = (r: Reader): string => bytesToUuid(r.fixed(16))

function signature(s: Uint8Array): Uint8Array {
  if (s.length !== SIG) throw new CodecError('signature must be 64 bytes')
  return s
}

function groupId(g: Uint8Array): Uint8Array {
  if (g.length === 0 || g.length > MAX_GROUP_ID) throw new CodecError('bad group id length')
  return g
}

function channelIds(ids: readonly ChannelId[]): ChannelId[] {
  if (ids.length > INVITE_MAX_SCOPE_CHANNELS) throw new CodecError(`more than ${INVITE_MAX_SCOPE_CHANNELS} channels`)
  for (let i = 1; i < ids.length; i++) {
    if (compareBytes(uuidToBytes(ids[i - 1]!), uuidToBytes(ids[i]!)) >= 0) throw new CodecError('channel ids not strictly ascending')
  }
  return [...ids]
}

/** The decoders read every u64 with `u64n()`, so the encoders accept only what it returns. */
function safeU64(v: number): number {
  if (!Number.isSafeInteger(v) || v < 0) throw new CodecError(`u64 must be a safe non-negative integer: ${v}`)
  return v
}

function historyKeys(keys: readonly HistoryKey[]): HistoryKey[] {
  if (keys.length === 0 || keys.length > HISTORY_BUNDLE_MAX_EPOCHS) throw new CodecError(`an invite bundle has 1 to ${HISTORY_BUNDLE_MAX_EPOCHS} keys`)
  for (const k of keys) safeU64(k.epoch)
  for (let i = 1; i < keys.length; i++) if (keys[i]!.epoch <= keys[i - 1]!.epoch) throw new CodecError('history epochs not strictly ascending')
  return [...keys]
}

// MARK: - InviteRecord

export function encodeInviteRecord(rec: InviteRecord): Uint8Array {
  return encode((w) => {
    w.u8(INVITE_WIRE_VERSION)
    uuid(w, rec.guildId).fixed(rec.hpkePublic, KEY).fixed(rec.signPublic, KEY)
    w.vector(channelIds(rec.channelIds), (x, id) => void uuid(x, id))
    w.u64(safeU64(rec.adminChainSeq)).u64(safeU64(rec.expiresAtMs)).u32(rec.maxUses)
    uuid(w, rec.creatorUserId)
    uuid(w, rec.creatorDeviceId)
  })
}

export function decodeInviteRecord(b: Uint8Array): InviteRecord {
  if (b.length > MAX_RECORD_BYTES) throw new CodecError('invite record too large')
  return decode(b, (r) => {
    version(r)
    const guildId = readUuid(r)
    const hpkePublic = r.fixed(KEY)
    const signPublic = r.fixed(KEY)
    const ids = channelIds(r.vector(readUuid, INVITE_MAX_SCOPE_CHANNELS))
    return { guildId, hpkePublic, signPublic, channelIds: ids, adminChainSeq: r.u64n(), expiresAtMs: r.u64n(), maxUses: r.u32(), creatorUserId: readUuid(r), creatorDeviceId: readUuid(r) }
  })
}

/** The record as DsModule.verifyInviteRecord returns it. */
export function inviteRecordView(rec: InviteRecord): InviteRecordView {
  return {
    guildId: rec.guildId,
    hpkePublic: toB64url(rec.hpkePublic),
    keyId: toB64url(rec.signPublic),
    channelIds: [...rec.channelIds],
    adminChainSeq: rec.adminChainSeq,
    expiresAtMs: rec.expiresAtMs,
    maxUses: rec.maxUses,
    creatorUserId: rec.creatorUserId,
    creatorDeviceId: rec.creatorDeviceId,
  }
}

// MARK: - SignedInviteRecord

export function encodeSignedInviteRecord(s: SignedInviteRecord): Uint8Array {
  decodeInviteRecord(s.record)
  return encode((w) => void w.opaque(s.record).opaque(signature(s.signature)))
}

/** Also checks that `record` decodes. */
export function decodeSignedInviteRecord(b: Uint8Array): SignedInviteRecord {
  if (b.length > MAX_SIGNED_RECORD_BYTES) throw new CodecError('signed invite record too large')
  return decode(b, (r) => {
    const record = r.opaque(MAX_RECORD_BYTES)
    decodeInviteRecord(record)
    return { record, signature: signature(r.opaque(SIG)) }
  })
}

// MARK: - Invite bundles

export function encodeInviteBundleTbs(t: InviteBundleTbs): Uint8Array {
  return encode((w) => {
    w.u8(INVITE_WIRE_VERSION).fixed(t.signPublic, KEY).opaque(groupId(t.groupId)).vector(historyKeys(t.keys), writeHistoryKey)
    uuid(w, t.senderUserId)
    uuid(w, t.senderDeviceId)
  })
}

export function decodeInviteBundleTbs(b: Uint8Array): InviteBundleTbs {
  return decode(b, (r) => {
    version(r)
    const signPublic = r.fixed(KEY)
    const gid = groupId(r.opaque(MAX_GROUP_ID))
    const keys = historyKeys(r.vector(readHistoryKey, HISTORY_BUNDLE_MAX_EPOCHS))
    return { signPublic, groupId: gid, keys, senderUserId: readUuid(r), senderDeviceId: readUuid(r) }
  })
}

export function encodeInviteBundleContent(c: InviteBundleContent): Uint8Array {
  decodeInviteBundleTbs(c.tbs)
  return encode((w) => void w.opaque(c.tbs).opaque(signature(c.signature)))
}

/** Also checks that `tbs` decodes. */
export function decodeInviteBundleContent(b: Uint8Array): InviteBundleContent {
  return decode(b, (r) => {
    const tbs = r.opaque(INVITE_BUNDLE_MAX_BYTES)
    decodeInviteBundleTbs(tbs)
    return { tbs, signature: signature(r.opaque(SIG)) }
  })
}

export function encodeInviteBundle(b: InviteBundle): Uint8Array {
  const out = encode((w) => void w.u8(INVITE_WIRE_VERSION).fixed(b.enc, KEY).opaque(b.ciphertext))
  if (out.length > INVITE_BUNDLE_MAX_BYTES) throw new CodecError('invite bundle too large')
  return out
}

export function decodeInviteBundle(b: Uint8Array): InviteBundle {
  if (b.length > INVITE_BUNDLE_MAX_BYTES) throw new CodecError('invite bundle too large')
  return decode(b, (r) => {
    version(r)
    return { enc: r.fixed(KEY), ciphertext: r.opaque(INVITE_BUNDLE_MAX_BYTES) }
  })
}

// MARK: - InviteAuth

export function encodeInviteAuth(a: InviteAuth): Uint8Array {
  decodeSignedInviteRecord(a.signedRecord)
  return encode((w) => void w.u8(INVITE_WIRE_VERSION).opaque(a.signedRecord).opaque(signature(a.signature)))
}

/** Also checks that `signedRecord` decodes. */
export function decodeInviteAuth(b: Uint8Array): InviteAuth {
  return decode(b, (r) => {
    version(r)
    const signedRecord = r.opaque(MAX_SIGNED_RECORD_BYTES)
    decodeSignedInviteRecord(signedRecord)
    return { signedRecord, signature: signature(r.opaque(SIG)) }
  })
}

/** The InviteAuth signature content: encode(struct { opaque group_id<V>; opaque leaf_signature_key<V>; }). */
export function inviteAuthContent(gid: Uint8Array, leafSignatureKey: Uint8Array): Uint8Array {
  return encode((w) => void w.opaque(groupId(gid)).opaque(leafSignatureKey))
}
