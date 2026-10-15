/**
 * The few binary framings the DS reads or writes itself. They need no MLS
 * state and no group secrets:
 *  - the MLSMessage prefix of a PublicMessage (group id, epoch, sender), for the
 *    409 EpochConflict check before the full DsModule.checkCommit (§12.7.3 check 2);
 *  - the GroupContext of a GroupInfo (tree hash, confirmed transcript hash),
 *    for `mls_group_epochs` and `MLS_HANDSHAKE.next` (§12.8.7);
 *  - WelcomeItem (§12.7.6), the SealedDeviceMessage prefix (§12.5) and
 *    LinkOffer (§12.5).
 * Everything else goes through @hachiman/crypto/ds.
 */
import { bytesToUuid, ParseError, Reader } from './bytes'

const MLS10 = 1
const WIRE_PUBLIC = 1
const WIRE_GROUP_INFO = 4

export interface PublicMessagePrefix {
  groupId: Uint8Array
  epoch: number
  sender: { type: 'member'; leafIndex: number } | { type: 'external'; senderIndex: number } | { type: 'new_member_proposal' } | { type: 'new_member_commit' }
  contentType: 'application' | 'proposal' | 'commit'
}

/** MLSMessage(mls_public_message): the FramedContent fields up to content_type. */
export function parsePublicMessagePrefix(bytes: Uint8Array): PublicMessagePrefix {
  const r = new Reader(bytes)
  if (r.u16() !== MLS10) throw new ParseError('not mls10')
  if (r.u16() !== WIRE_PUBLIC) throw new ParseError('not a public message')
  const groupId = r.opaque()
  const epoch = r.u64()
  const senderType = r.u8()
  let sender: PublicMessagePrefix['sender']
  switch (senderType) {
    case 1:
      sender = { type: 'member', leafIndex: r.u32() }
      break
    case 2:
      sender = { type: 'external', senderIndex: r.u32() }
      break
    case 3:
      sender = { type: 'new_member_proposal' }
      break
    case 4:
      sender = { type: 'new_member_commit' }
      break
    default:
      throw new ParseError('bad sender type')
  }
  r.opaque() // authenticated_data
  const ct = r.u8()
  const contentType = ct === 1 ? 'application' : ct === 2 ? 'proposal' : ct === 3 ? 'commit' : null
  if (!contentType) throw new ParseError('bad content type')
  return { groupId: new Uint8Array(groupId), epoch, sender, contentType }
}

export interface GroupContextSummary {
  cipherSuite: number
  groupId: Uint8Array
  epoch: number
  treeHash: Uint8Array
  confirmedTranscriptHash: Uint8Array
}

/** MLSMessage(mls_group_info): the GroupContext at its start. */
export function parseGroupInfoContext(bytes: Uint8Array): GroupContextSummary {
  const r = new Reader(bytes)
  if (r.u16() !== MLS10) throw new ParseError('not mls10')
  if (r.u16() !== WIRE_GROUP_INFO) throw new ParseError('not a group info')
  if (r.u16() !== MLS10) throw new ParseError('group context not mls10')
  const cipherSuite = r.u16()
  const groupId = new Uint8Array(r.opaque())
  const epoch = r.u64()
  const treeHash = new Uint8Array(r.opaque())
  const confirmedTranscriptHash = new Uint8Array(r.opaque())
  return { cipherSuite, groupId, epoch, treeHash, confirmedTranscriptHash }
}

// MARK: - Writer

function varint(v: number): number[] {
  if (v < 0x40) return [v]
  if (v < 0x4000) return [0x40 | (v >> 8), v & 0xff]
  if (v < 0x40000000) return [0x80 | (v >>> 24), (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  throw new Error('varint out of range')
}

function u64(v: number): number[] {
  const hi = Math.floor(v / 0x100000000)
  const lo = v >>> 0
  return [hi >>> 24, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff, lo >>> 24, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff]
}

function opaque(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(varint(b.length).length + b.length)
  const prefix = varint(b.length)
  out.set(prefix, 0)
  out.set(b, prefix.length)
  return out
}

function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
  let off = 0
  for (const a of arrays) {
    out.set(a, off)
    off += a.length
  }
  return out
}

/** struct { uint8 version = 1; opaque group_id<V>; uint64 epoch; opaque welcome<V>; } WelcomeItem (§12.7.6). */
export function encodeWelcomeItem(groupId: Uint8Array, epoch: number, welcome: Uint8Array): Uint8Array {
  return concat([[1], opaque(groupId), u64(epoch), opaque(welcome)])
}

export function decodeWelcomeItem(bytes: Uint8Array): { groupId: Uint8Array; epoch: number; welcome: Uint8Array } {
  const r = new Reader(bytes)
  if (r.u8() !== 1) throw new ParseError('bad version')
  const groupId = new Uint8Array(r.opaque())
  const epoch = r.u64()
  const welcome = new Uint8Array(r.opaque())
  r.end()
  return { groupId, epoch, welcome }
}

/** SealedDeviceMessage (§12.5): version, kind and sender. The ciphertext stays opaque. */
export function parseSealedDeviceMessage(bytes: Uint8Array): { kind: 'dsk_transfer' | 'history_keys'; senderDeviceId: string } {
  const r = new Reader(bytes)
  if (r.u8() !== 1) throw new ParseError('bad version')
  const k = r.u8()
  const kind = k === 2 ? 'dsk_transfer' : k === 3 ? 'history_keys' : null
  if (!kind) throw new ParseError('bad kind')
  const senderDeviceId = bytesToUuid(r.fixed(16))
  r.fixed(32) // enc
  r.opaque() // ciphertext
  r.end()
  return { kind, senderDeviceId }
}

export interface LinkOfferFields {
  userId: string
  deviceId: string
  mode: 'qr' | 'sas'
  mlsSignatureKey: Uint8Array
  hpkeKey: Uint8Array
}

/** LinkOffer (§12.5). */
export function parseLinkOffer(bytes: Uint8Array): LinkOfferFields {
  const r = new Reader(bytes)
  if (r.u8() !== 1) throw new ParseError('bad version')
  const userId = bytesToUuid(r.fixed(16))
  const deviceId = bytesToUuid(r.fixed(16))
  const m = r.u8()
  const mode = m === 1 ? 'qr' : m === 2 ? 'sas' : null
  if (!mode) throw new ParseError('bad mode')
  const commitment = r.opaque()
  if (mode === 'sas' ? commitment.length !== 32 : commitment.length !== 0) throw new ParseError('bad commitment')
  const mlsSignatureKey = new Uint8Array(r.opaque())
  if (mlsSignatureKey.length !== 32) throw new ParseError('bad signature key')
  const hpkeKey = new Uint8Array(r.fixed(32))
  const name = r.opaque()
  if (name.length < 1 || name.length > 64) throw new ParseError('bad device name')
  const platform = r.u8()
  // 1 electron, 2 browser, 3 ios
  if (platform < 1 || platform > 3) throw new ParseError('bad platform')
  r.end()
  return { userId, deviceId, mode, mlsSignatureKey, hpkeKey }
}

/** Test and tooling helpers: encoders for the framings above. */
export const encodeForTests = {
  publicMessagePrefix(p: { groupId: Uint8Array; epoch: number; senderLeaf: number | null; contentType: 2 | 3 }, rest: Uint8Array = new Uint8Array()): Uint8Array {
    const sender = p.senderLeaf === null ? [4] : [1, (p.senderLeaf >>> 24) & 0xff, (p.senderLeaf >>> 16) & 0xff, (p.senderLeaf >>> 8) & 0xff, p.senderLeaf & 0xff]
    return concat([[0, 1, 0, 1], opaque(p.groupId), u64(p.epoch), sender, [0], [p.contentType], rest])
  },
  groupInfo(c: GroupContextSummary, rest: Uint8Array = new Uint8Array()): Uint8Array {
    return concat([[0, 1, 0, 4, 0, 1, c.cipherSuite >> 8, c.cipherSuite & 0xff], opaque(c.groupId), u64(c.epoch), opaque(c.treeHash), opaque(c.confirmedTranscriptHash), rest])
  },
  sealedDeviceMessage(kind: 2 | 3, senderDeviceId: Uint8Array): Uint8Array {
    return concat([[1, kind], senderDeviceId, new Uint8Array(32), opaque(new Uint8Array([1, 2, 3]))])
  },
  linkOffer(o: { userId: Uint8Array; deviceId: Uint8Array; mlsSignatureKey: Uint8Array; hpkeKey: Uint8Array; platform?: number }): Uint8Array {
    return concat([[1], o.userId, o.deviceId, [1], opaque(new Uint8Array()), opaque(o.mlsSignatureKey), o.hpkeKey, opaque(new TextEncoder().encode('Laptop')), [o.platform ?? 1]])
  },
}
