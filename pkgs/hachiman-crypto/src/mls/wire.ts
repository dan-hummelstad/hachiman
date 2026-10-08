/**
 * Shared MLS helpers for the client wrapper (index.ts) and the Takusen helpers (ds.ts):
 * cipher suites, MLSMessage framing, the group id and descriptor codecs (§12.6), the group
 * context extensions, leaves as LeafEntry, and the device chain pre-check (§12.4).
 *
 * This file uses only ts-mls, @noble and globalThis.crypto, so ds.ts can import it in Node.
 */
import {
  type CiphersuiteImpl,
  type CiphersuiteName,
  type Credential,
  type Extension,
  type GroupContext,
  type GroupInfo,
  type KeyPackage,
  type LeafNode,
  type MLSMessage,
  type PrivateKeyPackage,
  type PublicMessage,
  type RatchetTree,
  type Welcome,
  bytesToBase64,
  decodeExternalSender,
  decodeMlsMessage,
  encodeExternalSender,
  encodeMlsMessage,
  encodeRequiredCapabilities,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from 'ts-mls'
import { extensionTypeToNumber } from 'ts-mls/extension.js'
import { encodeLeafNode } from 'ts-mls/leafNode.js'
import { decodeRatchetTree, encodeRatchetTree } from 'ts-mls/ratchetTree.js'

import { CryptoError, type ChainContext, type ChainVerdict, type DeviceChain, type GroupDescriptor, type GroupIdParts, type LeafEntry, type UserId } from '../api'
import { CodecError, bytesToUuid, decode, encode, uuidToBytes } from '../codec'
import {
  CIPHER_SUITE_NAME,
  ExtensionType,
  GROUP_ID_LENGTH,
  GroupKind,
  HistoryVisibility,
  WIRE_VERSION,
  type CipherSuiteId,
  type GroupKindName,
  type HistoryVisibilityName,
} from '../constants'
import { equalBytes } from '../identity/bytes'
import { identity, verifyChainMemo, type ChainSignatureMemo } from '../identity/index'

const te = new TextEncoder()
const td = new TextDecoder('utf-8', { fatal: true })

/** The BasicCredential identity of the DS external sender (§12.7.1). */
export const DS_CREDENTIAL_IDENTITY = 'takusen:ds'

// MARK: - Cipher suites

const suiteCache = new Map<CipherSuiteId, Promise<CiphersuiteImpl>>()

export function suiteName(id: CipherSuiteId): CiphersuiteName {
  const name = (CIPHER_SUITE_NAME as Record<number, CiphersuiteName | undefined>)[id]
  if (name === undefined) throw new CryptoError('Unsupported', `cipher suite ${id} is not accepted`)
  return name
}

export function suiteId(name: CiphersuiteName): CipherSuiteId {
  for (const [id, n] of Object.entries(CIPHER_SUITE_NAME)) if (n === name) return Number(id) as CipherSuiteId
  throw new CryptoError('Unsupported', `cipher suite ${name} is not accepted`)
}

export function suite(id: CipherSuiteId): Promise<CiphersuiteImpl> {
  let p = suiteCache.get(id)
  if (p === undefined) {
    p = getCiphersuiteImpl(getCiphersuiteFromName(suiteName(id)))
    suiteCache.set(id, p)
    p.catch(() => suiteCache.delete(id))
  }
  return p
}

// MARK: - MLSMessage framing

/** Decodes one MLSMessage and rejects trailing bytes. Throws CryptoError('Malformed'). */
export function decodeMessage(bytes: Uint8Array): MLSMessage {
  let r: [MLSMessage, number] | undefined
  try {
    r = decodeMlsMessage(bytes, 0)
  } catch (e) {
    throw new CryptoError('Malformed', `MLSMessage: ${(e as Error).message}`)
  }
  if (r === undefined) throw new CryptoError('Malformed', 'MLSMessage does not decode')
  if (r[1] !== bytes.length) throw new CryptoError('Malformed', 'MLSMessage has trailing bytes')
  // FZ-2: ts-mls reads some non-canonical bytes (an optional presence octet other than 0 or 1) as
  // a valid value. Only the canonical encoding is accepted, so one value has one byte string.
  if (!equalBytes(encodeMlsMessage(r[0]), bytes)) throw new CryptoError('Malformed', 'MLSMessage is not canonically encoded')
  return r[0]
}

export function decodePublicMessage(bytes: Uint8Array): PublicMessage {
  const m = decodeMessage(bytes)
  if (m.wireformat !== 'mls_public_message') throw new CryptoError('Malformed', `expected a PublicMessage, got ${m.wireformat}`)
  return m.publicMessage
}

export function decodeGroupInfoMessage(bytes: Uint8Array): GroupInfo {
  const m = decodeMessage(bytes)
  if (m.wireformat !== 'mls_group_info') throw new CryptoError('Malformed', `expected a GroupInfo, got ${m.wireformat}`)
  return m.groupInfo
}

export function decodeWelcomeMessage(bytes: Uint8Array): Welcome {
  const m = decodeMessage(bytes)
  if (m.wireformat !== 'mls_welcome') throw new CryptoError('Malformed', `expected a Welcome, got ${m.wireformat}`)
  return m.welcome
}

export function decodeKeyPackageMessage(bytes: Uint8Array): KeyPackage {
  const m = decodeMessage(bytes)
  if (m.wireformat !== 'mls_key_package') throw new CryptoError('Malformed', `expected a KeyPackage, got ${m.wireformat}`)
  return m.keyPackage
}

export const encodePublic = (publicMessage: PublicMessage): Uint8Array => encodeMlsMessage({ version: 'mls10', wireformat: 'mls_public_message', publicMessage })
export const encodeGroupInfoMessage = (groupInfo: GroupInfo): Uint8Array => encodeMlsMessage({ version: 'mls10', wireformat: 'mls_group_info', groupInfo })
export const encodeWelcomeMessage = (welcome: Welcome): Uint8Array => encodeMlsMessage({ version: 'mls10', wireformat: 'mls_welcome', welcome })
export const encodeKeyPackageMessage = (keyPackage: KeyPackage): Uint8Array => encodeMlsMessage({ version: 'mls10', wireformat: 'mls_key_package', keyPackage })

export function decodeTree(bytes: Uint8Array): RatchetTree {
  let r: [RatchetTree, number] | undefined
  try {
    r = decodeRatchetTree(bytes, 0)
  } catch (e) {
    throw new CryptoError('Malformed', `ratchet tree: ${(e as Error).message}`)
  }
  if (r === undefined) throw new CryptoError('Malformed', 'ratchet tree does not decode')
  if (r[1] !== bytes.length) throw new CryptoError('Malformed', 'ratchet tree has trailing bytes')
  if (r[0].length === 0) throw new CryptoError('Malformed', 'empty ratchet tree')
  if (!equalBytes(encodeRatchetTree(r[0]), bytes)) throw new CryptoError('Malformed', 'ratchet tree is not canonically encoded')
  return r[0]
}

export const encodeTree = (tree: RatchetTree): Uint8Array => encodeRatchetTree(tree)

/** The private half of a key package: init, HPKE and signature private keys. */
export function encodePrivatePackage(p: PrivateKeyPackage): Uint8Array {
  return encode((w) => w.u8(WIRE_VERSION).opaque(p.initPrivateKey).opaque(p.hpkePrivateKey).opaque(p.signaturePrivateKey))
}

export function decodePrivatePackage(b: Uint8Array): PrivateKeyPackage {
  try {
    return decode(b, (r) => {
      if (r.u8() !== WIRE_VERSION) throw new CodecError('private key package version')
      return { initPrivateKey: r.opaque(), hpkePrivateKey: r.opaque(), signaturePrivateKey: r.opaque() }
    })
  } catch (e) {
    throw new CryptoError('Malformed', `private key package: ${(e as Error).message}`)
  }
}

// MARK: - Group id and descriptor (§12.6)

const KIND_BYTE: Record<GroupKindName, number> = { public_set: GroupKind.PUBLIC_SET, channel: GroupKind.CHANNEL, dm: GroupKind.DM, voice: GroupKind.VOICE }
const KIND_NAME: Record<number, GroupKindName | undefined> = { 1: 'public_set', 2: 'channel', 3: 'dm', 4: 'voice' }
const VIS_BYTE: Record<HistoryVisibilityName, number> = { joined: HistoryVisibility.JOINED, shared: HistoryVisibility.SHARED }
const VIS_NAME: Record<number, HistoryVisibilityName | undefined> = { 1: 'joined', 2: 'shared' }

function kindName(b: number): GroupKindName {
  const k = KIND_NAME[b]
  if (k === undefined) throw new CodecError(`unknown group kind ${b}`)
  return k
}

export function groupId(parts: GroupIdParts): Uint8Array {
  if (!Number.isInteger(parts.generation) || parts.generation < 0 || parts.generation > 0xffffffff) throw new CryptoError('Malformed', 'generation out of range')
  try {
    return encode((w) => w.u8(WIRE_VERSION).u8(KIND_BYTE[parts.kind]).fixed(uuidToBytes(parts.scope), 16).u32(parts.generation))
  } catch (e) {
    throw new CryptoError('Malformed', `group id: ${(e as Error).message}`)
  }
}

export function parseGroupId(id: Uint8Array): GroupIdParts {
  if (id.length !== GROUP_ID_LENGTH) throw new CryptoError('Malformed', `group id must be ${GROUP_ID_LENGTH} bytes`)
  try {
    return decode(id, (r) => {
      if (r.u8() !== WIRE_VERSION) throw new CodecError('group id version')
      const kind = kindName(r.u8())
      return { kind, scope: bytesToUuid(r.fixed(16)), generation: r.u32() }
    })
  } catch (e) {
    throw new CryptoError('Malformed', `group id: ${(e as Error).message}`)
  }
}

/**
 * The per-kind rules of §12.6: guild_id for public_set and channel; channel_id for channel and dm;
 * exactly one of them for voice (a guild call or a DM call).
 */
function checkDescriptor(d: GroupDescriptor): void {
  if (d.kind === 'voice') {
    if ((d.guildId === null) === (d.channelId === null)) throw new CodecError('voice descriptor: exactly one of guild_id and channel_id')
    if (d.historyVisibility !== 'joined') throw new CodecError('voice descriptor: history_visibility must be joined')
    return
  }
  const needsGuild = d.kind !== 'dm'
  const needsChannel = d.kind === 'channel' || d.kind === 'dm'
  if (needsGuild !== (d.guildId !== null)) throw new CodecError(`${d.kind} descriptor: guild_id must be ${needsGuild ? 'set' : 'null'}`)
  if (needsChannel !== (d.channelId !== null)) throw new CodecError(`${d.kind} descriptor: channel_id must be ${needsChannel ? 'set' : 'null'}`)
}

export function encodeGroupDescriptor(d: GroupDescriptor): Uint8Array {
  try {
    checkDescriptor(d)
    return encode((w) =>
      w
        .u8(WIRE_VERSION)
        .u8(KIND_BYTE[d.kind])
        .optional(d.guildId, (x, v) => x.fixed(uuidToBytes(v), 16))
        .optional(d.channelId, (x, v) => x.fixed(uuidToBytes(v), 16))
        .u8(VIS_BYTE[d.historyVisibility])
        .fixed(uuidToBytes(d.createdByUserId), 16),
    )
  } catch (e) {
    throw new CryptoError('Malformed', `group descriptor: ${(e as Error).message}`)
  }
}

export function decodeGroupDescriptor(b: Uint8Array): GroupDescriptor {
  try {
    const d = decode(b, (r): GroupDescriptor => {
      if (r.u8() !== WIRE_VERSION) throw new CodecError('descriptor version')
      const kind = kindName(r.u8())
      const guildId = r.optional((x) => bytesToUuid(x.fixed(16)))
      const channelId = r.optional((x) => bytesToUuid(x.fixed(16)))
      const vis = VIS_NAME[r.u8()]
      if (vis === undefined) throw new CodecError('unknown history_visibility')
      return { kind, guildId, channelId, historyVisibility: vis, createdByUserId: bytesToUuid(r.fixed(16)) }
    })
    checkDescriptor(d)
    return d
  } catch (e) {
    throw new CryptoError('Malformed', `group descriptor: ${(e as Error).message}`)
  }
}

// MARK: - Group context extensions (§12.6)

/** required_capabilities: 0xF1A0 and 0xF1A1, no proposal types, credential type basic. */
export const REQUIRED_CAPABILITIES: Uint8Array = encodeRequiredCapabilities({
  extensionTypes: [ExtensionType.DEVICE_CHAIN, ExtensionType.GROUP_DESCRIPTOR],
  proposalTypes: [],
  credentialTypes: ['basic'],
})

/** Accepts the encoded ExternalSender, or a raw 32-byte Ed25519 key (then the credential is `takusen:ds`). */
export function normalizeExternalSender(bytes: Uint8Array): { encoded: Uint8Array; signatureKey: Uint8Array } {
  if (bytes.length === 32) {
    return { encoded: encodeExternalSender({ signaturePublicKey: bytes, credential: { credentialType: 'basic', identity: te.encode(DS_CREDENTIAL_IDENTITY) } }), signatureKey: bytes }
  }
  const r = decodeExternalSender(bytes, 0)
  if (r === undefined) throw new CryptoError('Malformed', 'ExternalSender does not decode')
  if (r[1] !== bytes.length) throw new CryptoError('Malformed', 'ExternalSender has trailing bytes')
  return { encoded: bytes, signatureKey: r[0].signaturePublicKey }
}

/** [external_senders (not for voice), required_capabilities, GROUP_DESCRIPTOR]. */
export function groupExtensions(descriptor: GroupDescriptor, dsExternalSender: Uint8Array | null): Extension[] {
  const out: Extension[] = []
  if (descriptor.kind === 'voice') {
    if (dsExternalSender !== null) throw new CryptoError('Unsupported', 'a voice group has no external sender')
  } else {
    if (dsExternalSender === null) throw new CryptoError('Unsupported', `a ${descriptor.kind} group needs the DS external sender`)
    out.push({ extensionType: 'external_senders', extensionData: normalizeExternalSender(dsExternalSender).encoded })
  }
  out.push({ extensionType: 'required_capabilities', extensionData: REQUIRED_CAPABILITIES })
  out.push({ extensionType: ExtensionType.GROUP_DESCRIPTOR, extensionData: encodeGroupDescriptor(descriptor) })
  return out
}

export const extTypeNumber = (e: Extension): number => extensionTypeToNumber(e.extensionType)

export function findExtension(exts: readonly Extension[], type: number): Extension | undefined {
  return exts.find((e) => extTypeNumber(e) === type)
}

const EXT_EXTERNAL_SENDERS = 5
const EXT_REQUIRED_CAPABILITIES = 3

export interface ContextExtensions {
  types: number[]
  externalSenders: Uint8Array | null
  requiredCapabilities: Uint8Array | null
  descriptor: GroupDescriptor | null
}

export function readContextExtensions(exts: readonly Extension[]): ContextExtensions {
  let descriptor: GroupDescriptor | null = null
  const d = findExtension(exts, ExtensionType.GROUP_DESCRIPTOR)
  if (d !== undefined) {
    try {
      descriptor = decodeGroupDescriptor(d.extensionData)
    } catch {
      descriptor = null
    }
  }
  return {
    types: exts.map(extTypeNumber),
    externalSenders: findExtension(exts, EXT_EXTERNAL_SENDERS)?.extensionData ?? null,
    requiredCapabilities: findExtension(exts, EXT_REQUIRED_CAPABILITIES)?.extensionData ?? null,
    descriptor,
  }
}

/**
 * The §12.6 layout of a group context: extension order, exactly one external sender equal to the
 * pinned DS key (none for voice), the required capabilities, and a descriptor. Returns a reason or null.
 */
export function checkContextLayout(ctx: GroupContext, expect: { kind: GroupKindName; dsExternalSenderKey: Uint8Array | null }): string | null {
  const e = readContextExtensions(ctx.extensions)
  const want = expect.kind === 'voice' ? [EXT_REQUIRED_CAPABILITIES, ExtensionType.GROUP_DESCRIPTOR] : [EXT_EXTERNAL_SENDERS, EXT_REQUIRED_CAPABILITIES, ExtensionType.GROUP_DESCRIPTOR]
  if (e.types.length !== want.length || e.types.some((t, i) => t !== want[i])) return 'extension_order'
  if (e.requiredCapabilities === null || !equalBytes(e.requiredCapabilities, REQUIRED_CAPABILITIES)) return 'required_capabilities'
  if (e.descriptor === null) return 'descriptor'
  if (e.descriptor.kind !== expect.kind) return 'descriptor_kind'
  // The group id names the same kind and scope as the descriptor (§12.6).
  let parts: GroupIdParts
  try {
    parts = parseGroupId(ctx.groupId)
  } catch {
    return 'group_id'
  }
  const d = e.descriptor
  if (parts.kind !== d.kind) return 'group_id_kind'
  if (d.kind === 'public_set' && parts.scope !== d.guildId) return 'group_id_scope'
  if ((d.kind === 'channel' || d.kind === 'dm') && parts.scope !== d.channelId) return 'group_id_scope'
  if (expect.kind !== 'voice') {
    if (expect.dsExternalSenderKey === null || e.externalSenders === null) return 'external_sender'
    let key: Uint8Array
    try {
      key = normalizeExternalSender(e.externalSenders).signatureKey
    } catch {
      return 'external_sender'
    }
    if (!equalBytes(key, expect.dsExternalSenderKey)) return 'external_sender'
  }
  return null
}

/**
 * A GroupContextExtensions proposal may change only history_visibility (§12.6): the same extension
 * order, byte-identical external_senders and required_capabilities, and a descriptor that differs
 * only in history_visibility. Returns a reason or null.
 */
export function checkGceChange(current: readonly Extension[], next: readonly Extension[]): string | null {
  const a = readContextExtensions(current)
  const b = readContextExtensions(next)
  if (a.types.length !== b.types.length || a.types.some((t, i) => t !== b.types[i])) return 'gce_extension_order'
  if (!sameNullableBytes(a.externalSenders, b.externalSenders)) return 'gce_external_senders'
  if (!sameNullableBytes(a.requiredCapabilities, b.requiredCapabilities)) return 'gce_required_capabilities'
  if (a.descriptor === null || b.descriptor === null) return 'gce_descriptor'
  const x = a.descriptor
  const y = b.descriptor
  if (x.kind !== y.kind || x.guildId !== y.guildId || x.channelId !== y.channelId || x.createdByUserId !== y.createdByUserId) return 'gce_descriptor_fields'
  return null
}

function sameNullableBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b
  return equalBytes(a, b)
}

// MARK: - Leaves

export function basicCredential(userId: UserId, deviceId: string): Credential {
  return { credentialType: 'basic', identity: te.encode(identity.credentialIdentity(userId, deviceId)) }
}

/** The credential identity text of a leaf, or null when it is not a BasicCredential in UTF-8. */
export function credentialText(c: Credential): string | null {
  if (c.credentialType !== 'basic') return null
  try {
    return td.decode(c.identity)
  } catch {
    return null
  }
}

export function leafChain(leaf: LeafNode): DeviceChain | null {
  const ext = findExtension(leaf.extensions, ExtensionType.DEVICE_CHAIN)
  if (ext === undefined) return null
  try {
    return identity.decodeDeviceChain(ext.extensionData)
  } catch {
    return null
  }
}

/** The leaf as the roster sees it, or null when the credential is not `{userId}:{deviceId}`. */
export function leafEntry(leaf: LeafNode, leafIndex: number): LeafEntry | null {
  const text = credentialText(leaf.credential)
  const id = text === null ? null : identity.parseCredentialIdentity(text)
  if (id === null) return null
  return { leafIndex, userId: id.userId, deviceId: id.deviceId, signatureKey: leaf.signaturePublicKey, chain: leafChain(leaf) }
}

/** Leaves by leaf index (undefined for blank leaves). */
export function treeLeaves(tree: RatchetTree): (LeafNode | undefined)[] {
  const out: (LeafNode | undefined)[] = []
  for (let i = 0; i < tree.length; i += 2) {
    const n = tree[i]
    out.push(n?.nodeType === 'leaf' ? n.leaf : undefined)
  }
  return out
}

export function rosterOfTree(tree: RatchetTree): LeafEntry[] {
  const out: LeafEntry[] = []
  treeLeaves(tree).forEach((leaf, i) => {
    if (leaf === undefined) return
    const e = leafEntry(leaf, i)
    if (e !== null) out.push(e)
  })
  return out
}

/** Same member: equal credential identity and signature key (§12.7.3 check 5). */
export function sameMember(a: LeafNode | undefined, b: LeafNode | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  const x = credentialText(a.credential)
  const y = credentialText(b.credential)
  return x !== null && x === y && equalBytes(a.signaturePublicKey, b.signaturePublicKey)
}

export function sameLeafBytes(a: LeafNode | undefined, b: LeafNode | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return equalBytes(encodeLeafNode(a), encodeLeafNode(b))
}

/**
 * The chain pre-check of §12.4 for one leaf: credential identity, DEVICE_CHAIN extension, and
 * IdentityModule.verifyChain with the context of the user. Synchronous (the ts-mls callback is).
 */
/** Decoded DEVICE_CHAIN extensions and their signature results, by the extension bytes (bounded). */
const chainCache = new Map<string, { chain: DeviceChain; sigs: ChainSignatureMemo } | null>()
const CHAIN_CACHE_MAX = 4096

function cachedChain(leaf: LeafNode): { chain: DeviceChain; sigs: ChainSignatureMemo } | null {
  const ext = findExtension(leaf.extensions, ExtensionType.DEVICE_CHAIN)
  if (ext === undefined) return null
  const key = bytesToBase64(ext.extensionData)
  const hit = chainCache.get(key)
  if (hit !== undefined) return hit
  let v: { chain: DeviceChain; sigs: ChainSignatureMemo } | null
  try {
    v = { chain: identity.decodeDeviceChain(ext.extensionData), sigs: {} }
  } catch {
    v = null
  }
  if (chainCache.size >= CHAIN_CACHE_MAX) chainCache.delete(chainCache.keys().next().value!)
  chainCache.set(key, v)
  return v
}

export function checkLeafChain(leaf: LeafNode, ctxFor: (userId: UserId) => ChainContext, entering: boolean): ChainVerdict {
  const text = credentialText(leaf.credential)
  const id = text === null ? null : identity.parseCredentialIdentity(text)
  if (text === null || id === null) return { ok: false, reason: 'malformed' }
  const c = cachedChain(leaf)
  if (c === null) return { ok: false, reason: 'malformed' }
  const base = ctxFor(id.userId)
  return verifyChainMemo(c.chain, { ...base, entering, leaf: { credentialIdentity: text, signatureKey: leaf.signaturePublicKey } }, c.sigs)
}

export function bigintEpoch(e: bigint): number {
  if (e > BigInt(Number.MAX_SAFE_INTEGER)) throw new CryptoError('Malformed', 'epoch exceeds 2^53')
  return Number(e)
}

/** Big-endian uint64. */
export function u64(n: number): Uint8Array {
  return encode((w) => w.u64(n))
}
