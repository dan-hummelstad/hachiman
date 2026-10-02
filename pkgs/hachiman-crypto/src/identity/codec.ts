/**
 * Byte layouts of the identity objects (docs/gateway-protocol.md §12.4, §12.5, §12.11.3).
 * Every encoder is deterministic. Every decoder rejects trailing bytes, unknown versions and
 * out-of-range enum values. Decoders do not verify signatures: see identity/index.ts.
 */
import type {
  BackupKindId,
  DeviceCertificate,
  DeviceChain,
  DevicePlatform,
  DeviceRevocation,
  DeviceSigningKeyCert,
  HistoryKeyEntry,
  LinkMessage,
  LinkOffer,
  LinkTransfer,
  MasterKeyRecord,
  RevocationReasonId,
} from '../api'
import { CodecError, Reader, Writer, bytesToUuid, decode, encode, uuidToBytes } from '../codec'
import { WIRE_VERSION } from '../constants'

const KEY = 32
const MAX_NAME_BYTES = 64
/** Room for a group id (22 bytes) and future formats, never unbounded. */
const MAX_GROUP_ID = 64
const MAX_SIG = 64

function version(r: Reader): void {
  const v = r.u8()
  if (v !== WIRE_VERSION) throw new CodecError(`unsupported version ${v}`)
}

const uuid = (w: Writer, id: string): Writer => w.fixed(uuidToBytes(id), 16)
const readUuid = (r: Reader): string => bytesToUuid(r.fixed(16))

function name(w: Writer, s: string): void {
  const b = new TextEncoder().encode(s)
  if (b.length < 1 || b.length > MAX_NAME_BYTES) throw new CodecError('name must be 1 to 64 UTF-8 bytes')
  w.opaque(b)
}
function readName(r: Reader): string {
  const s = r.utf8(MAX_NAME_BYTES)
  if (s.length === 0) throw new CodecError('empty name')
  return s
}

function sig(r: Reader): Uint8Array {
  return r.opaque(MAX_SIG)
}

// MARK: - Master key

export function writeMasterKeyTbs(w: Writer, r: Omit<MasterKeyRecord, 'prevSignature' | 'signature'>): void {
  w.u8(WIRE_VERSION)
  uuid(w, r.userId)
  w.fixed(r.publicKey, KEY).u32(r.generation).u64(r.createdAtMs)
}
export const encodeMasterKeyTbs = (r: Omit<MasterKeyRecord, 'prevSignature' | 'signature'>): Uint8Array =>
  encode((w) => {
    writeMasterKeyTbs(w, r)
  })

export function writeMasterKeyRecord(w: Writer, r: MasterKeyRecord): void {
  writeMasterKeyTbs(w, r)
  w.optional(r.prevSignature, (x, s) => x.opaque(s))
  w.opaque(r.signature)
}
export function readMasterKeyRecord(r: Reader): MasterKeyRecord {
  version(r)
  const userId = readUuid(r)
  const publicKey = r.fixed(KEY)
  const generation = r.u32()
  const createdAtMs = r.u64n()
  const prevSignature = r.optional(sig)
  const signature = sig(r)
  return { userId, publicKey, generation, createdAtMs, prevSignature, signature }
}

// MARK: - Device-signing key

export function writeDskTbs(w: Writer, c: Omit<DeviceSigningKeyCert, 'signature'>): void {
  w.u8(WIRE_VERSION)
  uuid(w, c.userId)
  w.fixed(c.publicKey, KEY).u32(c.generation).u32(c.masterGeneration).u64(c.issuedAtMs)
}
export const encodeDskTbs = (c: Omit<DeviceSigningKeyCert, 'signature'>): Uint8Array =>
  encode((w) => {
    writeDskTbs(w, c)
  })

export function writeDskCert(w: Writer, c: DeviceSigningKeyCert): void {
  writeDskTbs(w, c)
  w.opaque(c.signature)
}
export function readDskCert(r: Reader): DeviceSigningKeyCert {
  version(r)
  const userId = readUuid(r)
  const publicKey = r.fixed(KEY)
  const generation = r.u32()
  const masterGeneration = r.u32()
  const issuedAtMs = r.u64n()
  return { userId, publicKey, generation, masterGeneration, issuedAtMs, signature: sig(r) }
}

// MARK: - Device certificate

export function writeDeviceCertTbs(w: Writer, c: Omit<DeviceCertificate, 'signature'>): void {
  w.u8(WIRE_VERSION)
  uuid(w, c.userId)
  uuid(w, c.deviceId)
  if (c.mlsSignatureKey.length !== KEY) throw new CodecError('mls_signature_key must be 32 bytes')
  w.opaque(c.mlsSignatureKey)
  w.fixed(c.hpkeKey, KEY).u32(c.dskGeneration).u64(c.issuedAtMs)
  name(w, c.displayName)
}
export const encodeDeviceCertTbs = (c: Omit<DeviceCertificate, 'signature'>): Uint8Array =>
  encode((w) => {
    writeDeviceCertTbs(w, c)
  })

export function writeDeviceCert(w: Writer, c: DeviceCertificate): void {
  writeDeviceCertTbs(w, c)
  w.opaque(c.signature)
}
export function readDeviceCert(r: Reader): DeviceCertificate {
  version(r)
  const userId = readUuid(r)
  const deviceId = readUuid(r)
  const mlsSignatureKey = r.opaque(KEY)
  if (mlsSignatureKey.length !== KEY) throw new CodecError('mls_signature_key must be 32 bytes')
  const hpkeKey = r.fixed(KEY)
  const dskGeneration = r.u32()
  const issuedAtMs = r.u64n()
  const displayName = readName(r)
  return { userId, deviceId, mlsSignatureKey, hpkeKey, dskGeneration, issuedAtMs, displayName, signature: sig(r) }
}

export function writeDeviceChain(w: Writer, c: DeviceChain): void {
  writeMasterKeyRecord(w, c.master)
  writeDskCert(w, c.dsk)
  writeDeviceCert(w, c.device)
}
export function readDeviceChain(r: Reader): DeviceChain {
  return { master: readMasterKeyRecord(r), dsk: readDskCert(r), device: readDeviceCert(r) }
}

// MARK: - Revocation

const isReason = (v: number): v is RevocationReasonId => v >= 1 && v <= 5

export function writeRevocationTbs(w: Writer, x: Omit<DeviceRevocation, 'signature'>): void {
  if (!isReason(x.reason)) throw new CodecError(`bad revocation reason ${x.reason as number}`)
  w.u8(WIRE_VERSION)
  uuid(w, x.userId)
  uuid(w, x.deviceId)
  w.u64(x.revokedAtMs).u8(x.reason).u32(x.masterGeneration)
}
export const encodeRevocationTbs = (x: Omit<DeviceRevocation, 'signature'>): Uint8Array =>
  encode((w) => {
    writeRevocationTbs(w, x)
  })

export function writeRevocation(w: Writer, x: DeviceRevocation): void {
  writeRevocationTbs(w, x)
  w.opaque(x.signature)
}
export function readRevocation(r: Reader): DeviceRevocation {
  version(r)
  const userId = readUuid(r)
  const deviceId = readUuid(r)
  const revokedAtMs = r.u64n()
  const reason = r.u8()
  if (!isReason(reason)) throw new CodecError(`bad revocation reason ${reason}`)
  const masterGeneration = r.u32()
  return { userId, deviceId, revokedAtMs, reason, masterGeneration, signature: sig(r) }
}

// MARK: - Verify QR (§12.5)

export interface VerifyQr {
  userId: string
  masterKey: Uint8Array
  peerUserId: string
  peerMasterKey: Uint8Array
}
export const encodeVerifyQr = (q: VerifyQr): Uint8Array =>
  encode((w) => {
    w.u8(WIRE_VERSION)
    uuid(w, q.userId).fixed(q.masterKey, KEY)
    uuid(w, q.peerUserId).fixed(q.peerMasterKey, KEY)
  })
export const decodeVerifyQr = (b: Uint8Array): VerifyQr =>
  decode(b, (r) => {
    version(r)
    return { userId: readUuid(r), masterKey: r.fixed(KEY), peerUserId: readUuid(r), peerMasterKey: r.fixed(KEY) }
  })

// MARK: - Device linking (§12.5)

const MODE = { qr: 1, sas: 2 } as const
const PLATFORM = { electron: 1, browser: 2 } as const

export function writeLinkOffer(w: Writer, o: LinkOffer): void {
  w.u8(WIRE_VERSION)
  uuid(w, o.userId)
  uuid(w, o.deviceId)
  w.u8(MODE[o.mode])
  w.opaque(o.commitment)
  if (o.mlsSignatureKey.length !== KEY) throw new CodecError('mls_signature_key must be 32 bytes')
  w.opaque(o.mlsSignatureKey)
  w.fixed(o.hpkeKey, KEY)
  name(w, o.deviceName)
  w.u8(PLATFORM[o.platform])
}
export function readLinkOffer(r: Reader): LinkOffer {
  version(r)
  const userId = readUuid(r)
  const deviceId = readUuid(r)
  const m = r.u8()
  const mode = m === 1 ? 'qr' : m === 2 ? 'sas' : null
  if (mode === null) throw new CodecError(`bad link mode ${m}`)
  const commitment = r.opaque(32)
  if (commitment.length !== (mode === 'sas' ? 32 : 0)) throw new CodecError('bad link commitment length')
  const mlsSignatureKey = r.opaque(KEY)
  if (mlsSignatureKey.length !== KEY) throw new CodecError('mls_signature_key must be 32 bytes')
  const hpkeKey = r.fixed(KEY)
  const deviceName = readName(r)
  const p = r.u8()
  const platform: DevicePlatform | null = p === 1 ? 'electron' : p === 2 ? 'browser' : null
  if (platform === null) throw new CodecError(`bad platform ${p}`)
  return { userId, deviceId, mode, commitment, mlsSignatureKey, hpkeKey, deviceName, platform }
}
export const encodeLinkOffer = (o: LinkOffer): Uint8Array =>
  encode((w) => {
    writeLinkOffer(w, o)
  })
export const decodeLinkOffer = (b: Uint8Array): LinkOffer => decode(b, readLinkOffer)

export interface LinkQr {
  offer: LinkOffer
  sessionId: string
  ephemeralPublic: Uint8Array
  linkSecret: Uint8Array
}
export const encodeLinkQr = (q: LinkQr): Uint8Array =>
  encode((w) => {
    writeLinkOffer(w, q.offer)
    uuid(w, q.sessionId).fixed(q.ephemeralPublic, KEY).fixed(q.linkSecret, 16)
  })
export const decodeLinkQr = (b: Uint8Array): LinkQr =>
  decode(b, (r) => ({ offer: readLinkOffer(r), sessionId: readUuid(r), ephemeralPublic: r.fixed(KEY), linkSecret: r.fixed(16) }))

const ABORT = { sas_mismatch: 1, cancelled: 2, error: 3 } as const

export const encodeLinkMessage = (m: LinkMessage): Uint8Array =>
  encode((w) => {
    switch (m.type) {
      case 'accept':
        w.u8(1)
        uuid(w, m.existingDeviceId).fixed(m.ephemeralPublic, KEY)
        return
      case 'reveal':
        w.u8(2).fixed(m.ephemeralPublic, KEY)
        return
      case 'transfer':
        w.u8(3).opaque(m.sealed)
        return
      case 'done':
        w.u8(4).fixed(m.confirmation, 32)
        return
      case 'abort':
        w.u8(5).u8(ABORT[m.reason])
        return
    }
  })
export const decodeLinkMessage = (b: Uint8Array): LinkMessage =>
  decode(b, (r): LinkMessage => {
    const t = r.u8()
    switch (t) {
      case 1:
        return { type: 'accept', existingDeviceId: readUuid(r), ephemeralPublic: r.fixed(KEY) }
      case 2:
        return { type: 'reveal', ephemeralPublic: r.fixed(KEY) }
      case 3:
        return { type: 'transfer', sealed: r.opaque() }
      case 4:
        return { type: 'done', confirmation: r.fixed(32) }
      case 5: {
        const v = r.u8()
        const reason = v === 1 ? 'sas_mismatch' : v === 2 ? 'cancelled' : v === 3 ? 'error' : null
        if (reason === null) throw new CodecError(`bad abort reason ${v}`)
        return { type: 'abort', reason }
      }
      default:
        throw new CodecError(`bad link message type ${t}`)
    }
  })

// MARK: - History keys (§12.11)

/** struct { uint64 epoch; opaque secret[32]; } HistoryKey. */
export interface HistoryKey {
  epoch: number
  secret: Uint8Array
}
const writeHistoryKey = (w: Writer, k: HistoryKey): void => void w.u64(k.epoch).fixed(k.secret, 32)
const readHistoryKey = (r: Reader): HistoryKey => ({ epoch: r.u64n(), secret: r.fixed(32) })

/** struct { opaque group_id<V>; HistoryKey keys<V>; } HistoryBatch. */
function writeHistoryBatch(w: Writer, groupId: Uint8Array, keys: readonly HistoryKey[]): void {
  if (groupId.length === 0 || groupId.length > MAX_GROUP_ID) throw new CodecError('bad group id length')
  w.opaque(groupId).vector(keys, writeHistoryKey)
}
function readHistoryBatch(r: Reader): HistoryKeyEntry[] {
  const groupId = r.opaque(MAX_GROUP_ID)
  if (groupId.length === 0) throw new CodecError('empty group id')
  const keys = r.vector(readHistoryKey)
  // The encoder never writes an empty batch (its group id would be lost in the entry list).
  if (keys.length === 0) throw new CodecError('empty history batch')
  return keys.map((k) => ({ groupId, epoch: k.epoch, secret: k.secret }))
}

/** Groups entries by group id (in first-seen order) and sorts each group by epoch. */
export function groupHistory(entries: readonly HistoryKeyEntry[]): { groupId: Uint8Array; keys: HistoryKey[] }[] {
  const byGroup = new Map<string, { groupId: Uint8Array; keys: HistoryKey[] }>()
  for (const e of entries) {
    const id = Array.from(e.groupId).join(',')
    let g = byGroup.get(id)
    if (!g) byGroup.set(id, (g = { groupId: e.groupId, keys: [] }))
    g.keys.push({ epoch: e.epoch, secret: e.secret })
  }
  for (const g of byGroup.values()) g.keys.sort((a, b) => a.epoch - b.epoch)
  return [...byGroup.values()]
}

/** One group's batch (kind 2 backup blob). All entries must have the same group id. */
export function encodeHistoryBatch(entries: readonly HistoryKeyEntry[]): Uint8Array {
  const groups = groupHistory(entries)
  if (groups.length !== 1) throw new CodecError('a history batch holds exactly one group')
  return encode((w) => {
    writeHistoryBatch(w, groups[0]!.groupId, groups[0]!.keys)
  })
}
export const decodeHistoryBatch = (b: Uint8Array): HistoryKeyEntry[] => decode(b, readHistoryBatch)

// MARK: - LinkTransfer

/**
 * struct { MasterKeyRecord master; DeviceSigningKeyCert dsk; opaque dsk_private_key[32];
 * DeviceCertificate device; HistoryBatch history<V>; } LinkTransfer.
 * The history vector holds HistoryBatch items, because a HistoryKey alone has no group id.
 */
export const encodeLinkTransfer = (t: LinkTransfer): Uint8Array =>
  encode((w) => {
    writeMasterKeyRecord(w, t.master)
    writeDskCert(w, t.dskCert)
    w.fixed(t.dskPrivateKey, KEY)
    writeDeviceCert(w, t.deviceCertificate)
    w.vector(groupHistory(t.historyKeys), (x, g) => {
      writeHistoryBatch(x, g.groupId, g.keys)
    })
  })
export const decodeLinkTransfer = (b: Uint8Array): LinkTransfer =>
  decode(b, (r) => {
    const master = readMasterKeyRecord(r)
    const dskCert = readDskCert(r)
    const dskPrivateKey = r.fixed(KEY)
    const deviceCertificate = readDeviceCert(r)
    const historyKeys = r.vector(readHistoryBatch).flat()
    return { master, dskCert, dskPrivateKey, deviceCertificate, historyKeys }
  })

// MARK: - Device messages (§12.5)

export type DeviceMessageKind = 'dsk_transfer' | 'history_keys'
export const DEVICE_MESSAGE_KIND = { dsk_transfer: 2, history_keys: 3 } as const

export interface SealedDeviceMessage {
  kind: DeviceMessageKind
  senderDeviceId: string
  enc: Uint8Array
  ciphertext: Uint8Array
}
export const encodeSealedDeviceMessage = (m: SealedDeviceMessage): Uint8Array =>
  encode((w) => {
    w.u8(WIRE_VERSION).u8(DEVICE_MESSAGE_KIND[m.kind])
    uuid(w, m.senderDeviceId).fixed(m.enc, 32).opaque(m.ciphertext)
  })
export const decodeSealedDeviceMessage = (b: Uint8Array): SealedDeviceMessage =>
  decode(b, (r) => {
    version(r)
    const k = r.u8()
    const kind: DeviceMessageKind | null = k === 2 ? 'dsk_transfer' : k === 3 ? 'history_keys' : null
    if (kind === null) throw new CodecError(`bad device message kind ${k}`)
    return { kind, senderDeviceId: readUuid(r), enc: r.fixed(32), ciphertext: r.opaque() }
  })

export interface DeviceMessagePlaintext {
  payload: Uint8Array
  signature: Uint8Array
}
export const encodeDeviceMessagePlaintext = (p: DeviceMessagePlaintext): Uint8Array =>
  encode((w) => w.opaque(p.payload).opaque(p.signature))
export const decodeDeviceMessagePlaintext = (b: Uint8Array): DeviceMessagePlaintext =>
  decode(b, (r) => ({ payload: r.opaque(), signature: sig(r) }))

/** struct { DeviceSigningKeyCert dsk; opaque dsk_private_key[32]; DeviceCertificate device; }. */
export interface DskTransfer {
  dsk: DeviceSigningKeyCert
  dskPrivateKey: Uint8Array
  device: DeviceCertificate
}
export const encodeDskTransfer = (t: DskTransfer): Uint8Array =>
  encode((w) => {
    writeDskCert(w, t.dsk)
    w.fixed(t.dskPrivateKey, KEY)
    writeDeviceCert(w, t.device)
  })
export const decodeDskTransfer = (b: Uint8Array): DskTransfer =>
  decode(b, (r) => ({ dsk: readDskCert(r), dskPrivateKey: r.fixed(KEY), device: readDeviceCert(r) }))

/** struct { uint8 type; opaque group_id<V>; uint64 epoch_from; uint64 epoch_to; HistoryKey keys<V>; }. */
export interface HistoryKeysPayload {
  type: 'request' | 'response'
  groupId: Uint8Array
  epochFrom: number
  epochTo: number
  keys: HistoryKey[]
}
export const encodeHistoryKeysPayload = (p: HistoryKeysPayload): Uint8Array =>
  encode((w) => {
    if (p.groupId.length === 0 || p.groupId.length > MAX_GROUP_ID) throw new CodecError('bad group id length')
    if (p.epochFrom > p.epochTo) throw new CodecError('epoch_from above epoch_to')
    w.u8(p.type === 'request' ? 1 : 2).opaque(p.groupId).u64(p.epochFrom).u64(p.epochTo).vector(p.keys, writeHistoryKey)
  })
export const decodeHistoryKeysPayload = (b: Uint8Array): HistoryKeysPayload =>
  decode(b, (r) => {
    const t = r.u8()
    if (t !== 1 && t !== 2) throw new CodecError(`bad history_keys type ${t}`)
    const groupId = r.opaque(MAX_GROUP_ID)
    if (groupId.length === 0) throw new CodecError('empty group id')
    const epochFrom = r.u64n()
    const epochTo = r.u64n()
    if (epochFrom > epochTo) throw new CodecError('epoch_from above epoch_to')
    const keys = r.vector(readHistoryKey)
    if (t === 1 && keys.length > 0) throw new CodecError('a request carries no keys')
    return { type: t === 1 ? 'request' : 'response', groupId, epochFrom, epochTo, keys }
  })

// MARK: - Backups (§12.11.3)

export interface BackupBlob {
  kind: BackupKindId
  keyId: Uint8Array
  nonce: Uint8Array
  ciphertext: Uint8Array
}
export const encodeBackupBlob = (b: BackupBlob): Uint8Array =>
  encode((w) => w.u8(WIRE_VERSION).u8(b.kind).fixed(b.keyId, 16).fixed(b.nonce, 12).opaque(b.ciphertext))
export const decodeBackupBlob = (bytes: Uint8Array): BackupBlob =>
  decode(bytes, (r) => {
    version(r)
    const kind = r.u8()
    if (kind !== 1 && kind !== 2) throw new CodecError(`bad backup kind ${kind}`)
    return { kind, keyId: r.fixed(16), nonce: r.fixed(12), ciphertext: r.opaque() }
  })

export interface IdentityBackup {
  master: MasterKeyRecord
  masterPrivateKey: Uint8Array
  dskCert: DeviceSigningKeyCert
  dskPrivateKey: Uint8Array
}
export const encodeIdentityBackup = (v: IdentityBackup): Uint8Array =>
  encode((w) => {
    writeMasterKeyRecord(w, v.master)
    w.fixed(v.masterPrivateKey, KEY)
    writeDskCert(w, v.dskCert)
    w.fixed(v.dskPrivateKey, KEY)
  })
export const decodeIdentityBackup = (b: Uint8Array): IdentityBackup =>
  decode(b, (r) => ({ master: readMasterKeyRecord(r), masterPrivateKey: r.fixed(KEY), dskCert: readDskCert(r), dskPrivateKey: r.fixed(KEY) }))
