/**
 * MlsModule (docs/gateway-protocol.md §12.6, §12.7, §12.11.2): the ts-mls wrapper that the
 * Worker engine uses. All handshakes are PublicMessage. MLS application messages are not used.
 *
 * Pinned by smoke.spec.ts: BasicCredential "userId:deviceId" plus the DEVICE_CHAIN leaf
 * extension; external_senders first with one sender; the ts-mls callback is synchronous, so the
 * chain checks run before processMessage; clientConfig is attached again after decodeGroupState;
 * an update path cannot change a chain (a chain change is a resync external commit).
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  type AuthenticationService,
  type ClientConfig,
  type ClientState,
  type IncomingMessageCallback,
  type LeafNode,
  type Proposal,
  type PublicMessage,
  bytesToBase64,
  createCommit,
  createGroup as mlsCreateGroup,
  createGroupInfoWithExternalPub,
  decodeGroupState,
  defaultCapabilities,
  emptyPskIndex,
  encodeGroupState,
  generateKeyPackageWithKey,
  joinGroup,
  joinGroupExternal,
  mlsExporter,
  processMessage,
} from 'ts-mls'
import { makeProposalRef } from 'ts-mls/authenticatedContent.js'
import { defaultClientConfig } from 'ts-mls/clientConfig.js'
import { makeKeyPackageRef } from 'ts-mls/keyPackage.js'

import {
  CryptoError,
  type DeviceId,
  type GroupDescriptor,
  type LeafEntry,
  type MlsGroupHandle,
  type MlsModule,
  type PendingCommit,
  type ProposalPolicy,
  type UserId,
} from '../api'
import { toB64url } from '../codec'
import { EXPORTER_LENGTH, ExporterLabel, ExtensionType, KEY_PACKAGE_LIFETIME_MS, type CipherSuiteId } from '../constants'
import { concatBytes, equalBytes } from '../identity/bytes'
import { identity } from '../identity/index'
import { decodeBundleHeader, openBundle, sealBundle, selectBundleKeys } from './history'
import { checkAddKeyPackage, checkGce, checkValueRemove, evaluateCommit, evaluateProposal, placeProposals, precheck } from './policy'
import {
  DS_CREDENTIAL_IDENTITY,
  bigintEpoch,
  checkContextLayout,
  checkLeafChain,
  credentialText,
  decodeGroupDescriptor,
  decodeGroupInfoMessage,
  decodeKeyPackageMessage,
  decodeMessage,
  decodePrivatePackage,
  decodeTree,
  decodeWelcomeMessage,
  encodeGroupDescriptor,
  encodeGroupInfoMessage,
  encodeKeyPackageMessage,
  encodePrivatePackage,
  encodePublic,
  encodeTree,
  encodeWelcomeMessage,
  extTypeNumber,
  findExtension,
  groupExtensions,
  groupId,
  leafEntry,
  parseGroupId,
  readContextExtensions,
  rosterOfTree,
  sameMember,
  suite,
  suiteId,
  treeLeaves,
  u64,
  basicCredential,
} from './wire'

export { decodeGroupDescriptor, encodeGroupDescriptor, groupId, parseGroupId } from './wire'

// MARK: - client config and handles

/** Every leaf credential must be "userId:deviceId"; the external sender is "takusen:ds" (§12.4, §12.7.1). */
const authService: AuthenticationService = {
  validateCredential(credential) {
    const text = credentialText(credential)
    return Promise.resolve(text !== null && (text === DS_CREDENTIAL_IDENTITY || identity.parseCredentialIdentity(text) !== null))
  },
}

/**
 * Hachiman sends only PublicMessage handshakes, so no secret tree of a past epoch is ever read.
 * ts-mls keeps retainKeysForEpochs of them in every state; 1 is its minimum (0 keeps all).
 */
export const clientConfig: ClientConfig = {
  ...defaultClientConfig,
  keyRetentionConfig: { ...defaultClientConfig.keyRetentionConfig, retainKeysForEpochs: 1 },
  authService,
}

const states = new WeakMap<MlsGroupHandle, ClientState>()

/** `state` encodes on first read: a handle that is never stored (a proposal within a batch) costs no encoding. */
function makeHandle(state: ClientState): MlsGroupHandle {
  let encoded: Uint8Array | null = null
  const handle = Object.freeze(
    Object.defineProperties(
      {
        groupId: state.groupContext.groupId,
        epoch: bigintEpoch(state.groupContext.epoch),
        cipherSuite: suiteId(state.groupContext.cipherSuite),
        ownLeaf: state.privatePath.leafIndex,
      },
      { state: { enumerable: true, get: () => (encoded ??= encodeGroupState(state)) } },
    ),
  ) as MlsGroupHandle
  states.set(handle, state)
  return handle
}

function restoredHandle(bytes: Uint8Array, state: ClientState): MlsGroupHandle {
  const handle: MlsGroupHandle = Object.freeze({
    groupId: state.groupContext.groupId,
    epoch: bigintEpoch(state.groupContext.epoch),
    cipherSuite: suiteId(state.groupContext.cipherSuite),
    ownLeaf: state.privatePath.leafIndex,
    state: bytes,
  })
  states.set(handle, state)
  return handle
}

function restoreState(bytes: Uint8Array): ClientState {
  let r
  try {
    r = decodeGroupState(bytes, 0)
  } catch (e) {
    throw new CryptoError('StoreCorrupt', `group state: ${(e as Error).message}`)
  }
  if (r === undefined) throw new CryptoError('StoreCorrupt', 'group state does not decode')
  if (r[1] !== bytes.length) throw new CryptoError('StoreCorrupt', 'group state has trailing bytes')
  return { ...r[0], clientConfig }
}

function stateOf(handle: MlsGroupHandle): ClientState {
  let s = states.get(handle)
  if (s === undefined) {
    s = restoreState(handle.state)
    states.set(handle, s)
  }
  return s
}

function capabilities() {
  const caps = defaultCapabilities()
  caps.extensions.push(ExtensionType.DEVICE_CHAIN, ExtensionType.GROUP_DESCRIPTOR)
  return caps
}

function decodeKeyPair(kp: { publicPackage: Uint8Array; privatePackage: Uint8Array }) {
  return { publicPackage: decodeKeyPackageMessage(kp.publicPackage), privatePackage: decodePrivatePackage(kp.privatePackage) }
}

function rosterOf(state: ClientState): LeafEntry[] {
  return rosterOfTree(state.ratchetTree)
}

/** Leaves at indexes that hold another member (or none) after the change. */
function diffRoster(before: ClientState, after: ClientState): { added: LeafEntry[]; removed: LeafEntry[] } {
  const a = treeLeaves(before.ratchetTree)
  const b = treeLeaves(after.ratchetTree)
  const added: LeafEntry[] = []
  const removed: LeafEntry[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (sameMember(a[i], b[i])) continue
    const x = a[i]
    const y = b[i]
    if (x !== undefined) {
      const e = leafEntry(x, i)
      if (e !== null) removed.push(e)
    }
    if (y !== undefined) {
      const e = leafEntry(y, i)
      if (e !== null) added.push(e)
    }
  }
  return { added, removed }
}

/**
 * Every leaf of a tree must pass the chain check (joins). A revoked device is the one exception
 * (§12.4 rule 7): a joiner holds no proposals, so it cannot see the queued Remove. The rest of the
 * chain must still pass (signatures, pin, DSK downgrade); only a DSK superseded by the
 * revocation's rotation is allowed. The joiner never encrypts to the leaf: GroupService.sendState
 * commits a Remove by value for every revoked leaf before it returns an epoch secret.
 */
function precheckTree(state: Pick<ClientState, 'ratchetTree'>, policy: ProposalPolicy, skipKey: Uint8Array | null): void {
  const unrevoked = (u: UserId) => ({ ...policy.chainContextFor(u), revokedDeviceIds: new Set<DeviceId>() })
  treeLeaves(state.ratchetTree).forEach((leaf, i) => {
    if (leaf === undefined) return
    if (skipKey !== null && equalBytes(leaf.signaturePublicKey, skipKey)) return
    const v = checkLeafChain(leaf, (u) => policy.chainContextFor(u), false)
    if (v.ok) return
    if (v.reason !== 'revoked') throw new CryptoError('InvalidChain', `leaf ${i}: ${v.reason}`)
    const rest = checkLeafChain(leaf, unrevoked, false)
    if (!rest.ok && rest.reason !== 'dsk_superseded') throw new CryptoError('InvalidChain', `leaf ${i}: revoked, and ${rest.reason}`)
  })
}

async function groupInfoOf(state: ClientState): Promise<{ groupInfo: Uint8Array; ratchetTree: Uint8Array }> {
  const cs = await suite(suiteId(state.groupContext.cipherSuite))
  const gi = await createGroupInfoWithExternalPub(state, [], cs)
  return { groupInfo: encodeGroupInfoMessage(gi), ratchetTree: encodeTree(state.ratchetTree) }
}

function wrap(e: unknown, code: 'Malformed' | 'InvalidChain' = 'Malformed'): CryptoError {
  if (e instanceof CryptoError) return e
  return new CryptoError(code, e instanceof Error ? e.message : String(e))
}

// MARK: - helpers that the GroupService uses before a call (prefetch, routing)

/** The users whose chain contexts a handshake needs (committer, adds, remove targets, the new leaf). */
export function handshakeUserIds(handle: MlsGroupHandle, message: Uint8Array): UserId[] {
  const state = stateOf(handle)
  const users = new Set<UserId>()
  const leaves = treeLeaves(state.ratchetTree)
  const addLeaf = (leaf: LeafNode | undefined): void => {
    const t = leaf === undefined ? null : credentialText(leaf.credential)
    const id = t === null ? null : identity.parseCredentialIdentity(t)
    if (id !== null) users.add(id.userId)
  }
  const visit = (p: Proposal): void => {
    if (p.proposalType === 'add') addLeaf(p.add.keyPackage.leafNode)
    else if (p.proposalType === 'remove') addLeaf(leaves[p.remove.removed])
  }
  let pm: PublicMessage
  try {
    const m = decodeMessage(message)
    if (m.wireformat !== 'mls_public_message') return []
    pm = m.publicMessage
  } catch {
    return []
  }
  const c = pm.content
  if (c.contentType === 'proposal') visit(c.proposal)
  if (c.contentType === 'commit') {
    if (c.sender.senderType === 'member') addLeaf(leaves[c.sender.leafIndex])
    addLeaf(c.commit.path?.leafNode)
    for (const p of c.commit.proposals) {
      if (p.proposalOrRefType === 'proposal') visit(p.proposal)
      else {
        const stored = state.unappliedProposals[bytesToBase64(p.reference)]
        if (stored !== undefined) visit(stored.proposal)
      }
    }
  }
  return [...users]
}

/**
 * The `authenticated_data` and the new leaf key of an external commit, when the data is not empty
 * (an InviteAuth, §12.11.4). Null for any other message. processHandshake verifies the signature
 * over both later.
 */
export function externalCommitAuth(message: Uint8Array): { authenticatedData: Uint8Array; leafSignatureKey: Uint8Array } | null {
  let c: PublicMessage['content']
  try {
    c = decodeMessageAsPublic(message).content
  } catch {
    return null
  }
  if (c.contentType !== 'commit' || c.sender.senderType !== 'new_member_commit' || c.commit.path === undefined || c.authenticatedData.length === 0) return null
  return { authenticatedData: c.authenticatedData, leafSignatureKey: c.commit.path.leafNode.signaturePublicKey }
}

/** Every user with a leaf in an encoded ratchet tree. */
export function treeUserIds(ratchetTree: Uint8Array): UserId[] {
  return [...new Set(rosterOfTree(decodeTree(ratchetTree)).map((e) => e.userId))]
}

/** The key package refs that a Welcome encrypts to. */
export function welcomeKeyPackageRefs(welcome: Uint8Array): Uint8Array[] {
  return decodeWelcomeMessage(welcome).secrets.map((s) => s.newMember)
}

/** The identity of a key package (MLSMessage key_package). */
export function keyPackageIdentity(bytes: Uint8Array): { userId: UserId; deviceId: DeviceId; credentialIdentity: string } {
  const kp = decodeKeyPackageMessage(bytes)
  const text = credentialText(kp.leafNode.credential)
  const id = text === null ? null : identity.parseCredentialIdentity(text)
  if (id === null || text === null) throw new CryptoError('Malformed', 'key package credential')
  return { ...id, credentialIdentity: text }
}

/** RFC 9420 ProposalRef of an MLSMessage (PublicMessage, content type proposal). */
export async function proposalRefOf(message: Uint8Array, cipherSuite: CipherSuiteId): Promise<Uint8Array> {
  const pm = decodeMessageAsPublic(message)
  if (pm.content.contentType !== 'proposal') throw new CryptoError('Malformed', 'not a proposal')
  const cs = await suite(cipherSuite)
  return makeProposalRef({ wireformat: 'mls_public_message', content: pm.content, auth: pm.auth }, cs.hash)
}

function decodeMessageAsPublic(message: Uint8Array): PublicMessage {
  const m = decodeMessage(message)
  if (m.wireformat !== 'mls_public_message') throw new CryptoError('Malformed', `expected a PublicMessage, got ${m.wireformat}`)
  return m.publicMessage
}

/** True when the state holds this stored proposal. */
export function hasStoredProposal(handle: MlsGroupHandle, ref: Uint8Array): boolean {
  return stateOf(handle).unappliedProposals[bytesToBase64(ref)] !== undefined
}

/**
 * The committer check of a stored proposal at commit time: an Add must still pass the chain,
 * readers and admin readers checks (they can change after the proposal was stored). Null when
 * it may go into the commit, or when the state does not hold it.
 */
export function checkStoredProposal(handle: MlsGroupHandle, ref: Uint8Array, policy: ProposalPolicy): string | null {
  const p = stateOf(handle).unappliedProposals[bytesToBase64(ref)]
  if (p?.proposal.proposalType !== 'add') return null
  return checkAddKeyPackage(p.proposal.add.keyPackage, policy)
}

/** The same state without these stored proposals: the next commit does not include them. */
export function dropStoredProposals(handle: MlsGroupHandle, refs: readonly Uint8Array[]): MlsGroupHandle {
  if (refs.length === 0) return handle
  const state = stateOf(handle)
  const drop = new Set(refs.map(bytesToBase64))
  const unappliedProposals = Object.fromEntries(Object.entries(state.unappliedProposals).filter(([k]) => !drop.has(k)))
  return makeHandle({ ...state, unappliedProposals })
}

/** The descriptor and the hashes of the current epoch (fork check, §12.8.7). */
export function contextOf(handle: MlsGroupHandle): { descriptor: GroupDescriptor | null; treeHash: Uint8Array; confirmedTranscriptHash: Uint8Array; active: boolean } {
  const s = stateOf(handle)
  return {
    descriptor: readContextExtensions(s.groupContext.extensions).descriptor,
    treeHash: s.groupContext.treeHash,
    confirmedTranscriptHash: s.groupContext.confirmedTranscriptHash,
    active: s.groupActiveState.kind === 'active',
  }
}

/** The leaf of the own device, as other members see it. */
export function ownLeafEntry(handle: MlsGroupHandle): LeafEntry | null {
  const s = stateOf(handle)
  const leaf = treeLeaves(s.ratchetTree)[s.privatePath.leafIndex]
  return leaf === undefined ? null : leafEntry(leaf, s.privatePath.leafIndex)
}

/** True when a tree has a leaf with this signature key (a resync, not a new join). */
export function treeHasSignatureKey(ratchetTree: Uint8Array, signatureKey: Uint8Array): boolean {
  return treeLeaves(decodeTree(ratchetTree)).some((l) => l !== undefined && equalBytes(l.signaturePublicKey, signatureKey))
}

/** The epoch of an encoded GroupInfo (no signature check). */
export function groupInfoEpoch(groupInfo: Uint8Array): number {
  return bigintEpoch(decodeGroupInfoMessage(groupInfo).groupContext.epoch)
}

/** An Add the committer may put in a commit: chain, readers, admin readers (or the voice roster). */
export function checkAdd(keyPackage: Uint8Array, policy: ProposalPolicy): string | null {
  let kp
  try {
    kp = decodeKeyPackageMessage(keyPackage)
  } catch {
    return 'malformed'
  }
  return checkAddKeyPackage(kp, policy)
}

// MARK: - the module

export const mls: MlsModule = {
  groupId,
  parseGroupId,
  encodeGroupDescriptor,
  decodeGroupDescriptor,

  async generateKeyPackages(input) {
    if (!Number.isInteger(input.count) || input.count < 1) throw new CryptoError('Malformed', 'count must be at least 1')
    const cs = await suite(input.cipherSuite)
    const { chain, signatureKey } = input
    if (!equalBytes(chain.device.mlsSignatureKey, signatureKey.publicKey)) throw new CryptoError('InvalidChain', 'the chain does not certify this signature key')
    const credential = basicCredential(chain.device.userId, chain.device.deviceId)
    const leafExt = [{ extensionType: ExtensionType.DEVICE_CHAIN, extensionData: identity.encodeDeviceChain(chain) }]
    const nowSec = BigInt(Math.floor(Date.now() / 1000))
    // One hour of slack for clock skew; the lifetime is at most KEY_PACKAGE_LIFETIME_MS (§12.7.2).
    const lifetime = { notBefore: nowSec - 3600n, notAfter: nowSec + BigInt(KEY_PACKAGE_LIFETIME_MS / 1000) - 3600n }
    const out: { publicPackage: Uint8Array; privatePackage: Uint8Array; ref: Uint8Array }[] = []
    for (let i = 0; i < input.count; i++) {
      const kp = await generateKeyPackageWithKey(credential, capabilities(), lifetime, [], { signKey: signatureKey.privateKey, publicKey: signatureKey.publicKey }, cs, leafExt)
      out.push({ publicPackage: encodeKeyPackageMessage(kp.publicPackage), privatePackage: encodePrivatePackage(kp.privatePackage), ref: await makeKeyPackageRef(kp.publicPackage, cs.hash) })
    }
    return out
  },

  async createGroup(input) {
    const parts = parseGroupId(input.groupId)
    const d = input.descriptor
    if (parts.kind !== d.kind) throw new CryptoError('Malformed', 'group id kind differs from the descriptor')
    if (d.kind === 'public_set' && parts.scope !== d.guildId) throw new CryptoError('Malformed', 'public_set scope must be the guild id')
    if ((d.kind === 'channel' || d.kind === 'dm') && parts.scope !== d.channelId) throw new CryptoError('Malformed', `${d.kind} scope must be the channel id`)
    const cs = await suite(input.cipherSuite)
    const kp = decodeKeyPair(input.keyPackage)
    const ownId = credentialText(kp.publicPackage.leafNode.credential)
    const self = ownId === null ? null : identity.parseCredentialIdentity(ownId)
    if (self?.userId !== d.createdByUserId) throw new CryptoError('Malformed', 'created_by_user_id must be the creator')
    let state: ClientState
    try {
      state = await mlsCreateGroup(input.groupId, kp.publicPackage, kp.privatePackage, groupExtensions(d, input.dsExternalSender), cs, clientConfig)
    } catch (e) {
      throw wrap(e)
    }
    const handle = makeHandle(state)
    return { handle, ...(await groupInfoOf(state)) }
  },

  async joinFromWelcome(input) {
    const welcome = decodeWelcomeMessage(input.welcome)
    const tree = decodeTree(input.ratchetTree)
    const kp = decodeKeyPair(input.keyPackage)
    precheckTree({ ratchetTree: tree }, input.policy, null)
    const cs = await suite(suiteId(welcome.cipherSuite))
    let state: ClientState
    try {
      state = await joinGroup(welcome, kp.publicPackage, kp.privatePackage, emptyPskIndex, cs, tree, undefined, clientConfig)
    } catch (e) {
      throw wrap(e)
    }
    const layout = checkContextLayout(state.groupContext, { kind: input.policy.kind, dsExternalSenderKey: input.policy.dsExternalSenderKey })
    if (layout !== null) throw new CryptoError('Malformed', `group context: ${layout}`)
    return makeHandle(state)
  },

  async joinExternal(input) {
    const gi = decodeGroupInfoMessage(input.groupInfo)
    const tree = decodeTree(input.ratchetTree)
    const kp = decodeKeyPair(input.keyPackage)
    const layout = checkContextLayout(gi.groupContext, { kind: input.policy.kind, dsExternalSenderKey: input.policy.dsExternalSenderKey })
    if (layout !== null) throw new CryptoError('Malformed', `group context: ${layout}`)
    if (input.policy.kind === 'voice') throw new CryptoError('Unsupported', 'voice groups reject external commits')
    const ownKey = kp.publicPackage.leafNode.signaturePublicKey
    // The own former leaf (resync) has the old chain, so it is not checked here.
    precheckTree({ ratchetTree: tree }, input.policy, input.resync ? ownKey : null)
    const own = checkLeafChain(kp.publicPackage.leafNode, (u) => input.policy.chainContextFor(u), true)
    if (!own.ok) throw new CryptoError('InvalidChain', `own leaf: ${own.reason}`)
    const before = treeLeaves(tree)
    const formerIndex = before.findIndex((l) => l !== undefined && equalBytes(l.signaturePublicKey, ownKey))
    if (input.resync !== formerIndex >= 0) throw new CryptoError('Malformed', input.resync ? 'no former leaf to resync' : 'the device already has a leaf: resync instead')
    const cs = await suite(suiteId(gi.groupContext.cipherSuite))
    let r
    try {
      r = await joinGroupExternal(gi, kp.publicPackage, kp.privatePackage, input.resync, cs, tree, clientConfig, input.authenticatedData)
    } catch (e) {
      throw wrap(e)
    }
    const next = makeHandle(r.newState)
    const ownEntry = ownLeafEntry(next)
    const former = formerIndex >= 0 ? before[formerIndex] : undefined
    const formerEntry = former === undefined ? null : leafEntry(former, formerIndex)
    return {
      groupId: gi.groupContext.groupId,
      epoch: bigintEpoch(gi.groupContext.epoch),
      request: { epoch: bigintEpoch(gi.groupContext.epoch), commit: toB64url(encodePublic(r.publicMessage)), ...b64(await groupInfoOf(r.newState)), welcome: null },
      next,
      added: ownEntry === null ? [] : [ownEntry],
      removed: formerEntry === null ? [] : [formerEntry],
    }
  },

  async processHandshake(handle, message, policy) {
    const state = stateOf(handle)
    if (state.groupActiveState.kind !== 'active') return { result: 'rejected', reason: 'not_active' }
    let pm: PublicMessage
    try {
      pm = decodeMessageAsPublic(message)
    } catch {
      return { result: 'rejected', reason: 'not_public_message' }
    }
    if (!equalBytes(pm.content.groupId, state.groupContext.groupId)) return { result: 'rejected', reason: 'wrong_group' }
    if (pm.content.epoch !== state.groupContext.epoch) return { result: 'rejected', reason: 'wrong_epoch' }
    const pre = precheck(state, pm, policy)
    if (pre !== null) return { result: 'rejected', reason: pre }
    const placed = pm.content.contentType === 'commit' ? placeProposals(state, pm) : []
    let reason = 'rejected'
    const callback: IncomingMessageCallback = (incoming) => {
      let why: string | null
      if (incoming.kind === 'proposal') why = evaluateProposal(state, pm, policy)
      else if (incoming.proposals.length !== placed.length) why = 'proposal_count'
      else why = evaluateCommit(state, pm, placed, policy)
      if (why !== null) reason = why
      return why === null ? 'accept' : 'reject'
    }
    const cs = await suite(handle.cipherSuite)
    let res
    try {
      res = await processMessage({ wireformat: 'mls_public_message', publicMessage: pm }, state, emptyPskIndex, callback, cs)
    } catch (e) {
      return { result: 'rejected', reason: `mls:${e instanceof Error ? e.message : String(e)}` }
    }
    if (res.kind !== 'newState' || res.actionTaken === 'reject') return { result: 'rejected', reason }
    const next = res.newState
    const nextHandle = makeHandle(next)
    const c = pm.content
    if (c.contentType === 'proposal') {
      const t = c.proposal.proposalType
      return { result: 'proposal_stored', handle: nextHandle, proposal: t === 'add' ? 'add' : t === 'remove' ? 'remove' : 'other' }
    }
    const { added, removed } = diffRoster(state, next)
    const selfRemoved = next.groupActiveState.kind === 'removedFromGroup'
    let committerLeaf: number | null = null
    if (c.sender.senderType === 'member') committerLeaf = c.sender.leafIndex
    else if (c.sender.senderType === 'new_member_commit' && c.contentType === 'commit' && c.commit.path !== undefined) {
      const key = c.commit.path.leafNode.signaturePublicKey
      const idx = treeLeaves(next.ratchetTree).findIndex((l) => l !== undefined && equalBytes(l.signaturePublicKey, key))
      committerLeaf = idx >= 0 ? idx : null
    }
    return { result: 'applied', handle: nextHandle, added, removed, committerLeaf, selfRemoved }
  },

  async commit(handle, input) {
    const state = stateOf(handle)
    if (state.groupActiveState.kind !== 'active') throw new CryptoError('NotMember', 'the device is not an active member')
    const policy = input.policy
    const leaves = treeLeaves(state.ratchetTree)
    const self = ownLeafEntry(handle)
    if (self === null) throw new CryptoError('NotMember', 'no own leaf')
    const extra: Proposal[] = []

    // Removes by value, without the leaves that a stored proposal removes already (§12.7.4).
    const storedRemoves = new Set<number>()
    for (const p of Object.values(state.unappliedProposals)) if (p.proposal.proposalType === 'remove') storedRemoves.add(p.proposal.remove.removed)
    const removes = new Set<number>()
    for (const leaf of input.removes) {
      if (storedRemoves.has(leaf) || removes.has(leaf)) continue
      if (leaf === handle.ownLeaf) throw new CryptoError('Unsupported', 'a committer cannot remove its own leaf')
      const why = checkValueRemove(leaves, leaf, self.userId, policy)
      if (why !== null) throw new CryptoError('Unsupported', `remove of leaf ${leaf}: ${why}`)
      removes.add(leaf)
    }
    for (const removed of removes) extra.push({ proposalType: 'remove', remove: { removed } })

    for (const bytes of input.adds) {
      const kp = decodeKeyPackageMessage(bytes)
      const why = checkAddKeyPackage(kp, policy)
      if (why !== null) throw new CryptoError(why.startsWith('invalid_chain') ? 'InvalidChain' : 'Unsupported', `add: ${why}`)
      extra.push({ proposalType: 'add', add: { keyPackage: kp } })
    }

    if (input.descriptor !== null) {
      const exts = state.groupContext.extensions.map((e) =>
        findExtension([e], ExtensionType.GROUP_DESCRIPTOR) !== undefined ? { extensionType: e.extensionType, extensionData: encodeGroupDescriptor(input.descriptor!) } : e,
      )
      const why = checkGce(state, exts, self.userId, policy)
      if (why !== null) throw new CryptoError('Unsupported', `descriptor change: ${why}`)
      extra.push({ proposalType: 'group_context_extensions', groupContextExtensions: { extensions: exts } })
    }

    const cs = await suite(handle.cipherSuite)
    let r
    try {
      r = await createCommit({ state, cipherSuite: cs }, { wireAsPublicMessage: true, extraProposals: extra })
    } catch (e) {
      throw wrap(e)
    }
    if (r.commit.wireformat !== 'mls_public_message') throw new CryptoError('Malformed', 'commit is not a PublicMessage')
    const next = makeHandle(r.newState)
    const { added, removed } = diffRoster(state, r.newState)
    return {
      groupId: state.groupContext.groupId,
      epoch: handle.epoch,
      request: {
        epoch: handle.epoch,
        commit: toB64url(encodePublic(r.commit.publicMessage)),
        ...b64(await groupInfoOf(r.newState)),
        welcome: r.welcome === undefined ? null : toB64url(encodeWelcomeMessage(r.welcome)),
      },
      next,
      added,
      removed,
    } satisfies PendingCommit
  },

  hasPendingRemoves(handle) {
    return Object.values(stateOf(handle).unappliedProposals).some((p) => p.proposal.proposalType === 'remove')
  },

  roster(handle) {
    return rosterOf(stateOf(handle))
  },

  async exporter(handle, label, context, length) {
    const s = stateOf(handle)
    const cs = await suite(handle.cipherSuite)
    return mlsExporter(s.keySchedule.exporterSecret, label, context, length, cs)
  },

  epochAuthenticator(handle) {
    return stateOf(handle).keySchedule.epochAuthenticator
  },

  groupInfo(handle) {
    return groupInfoOf(stateOf(handle))
  },

  matchesGroupInfo(handle, groupInfo) {
    const s = stateOf(handle)
    let gi
    try {
      gi = decodeGroupInfoMessage(groupInfo)
    } catch {
      return false
    }
    const a = s.groupContext
    const b = gi.groupContext
    if (a.epoch !== b.epoch || a.cipherSuite !== b.cipherSuite) return false
    if (!equalBytes(a.groupId, b.groupId) || !equalBytes(a.treeHash, b.treeHash) || !equalBytes(a.confirmedTranscriptHash, b.confirmedTranscriptHash)) return false
    if (a.extensions.length !== b.extensions.length) return false
    return a.extensions.every((e, i) => {
      const f = b.extensions[i]!
      return extTypeNumber(e) === extTypeNumber(f) && equalBytes(e.extensionData, f.extensionData)
    })
  },

  restore(state) {
    try {
      const s = restoreState(state)
      return Promise.resolve(restoredHandle(state, s))
    } catch (e) {
      return Promise.reject(wrap(e))
    }
  },

  async sealHistoryBundle(handle, signatureKey, senderDeviceId, entries) {
    const s = stateOf(handle)
    const own = ownLeafEntry(handle)
    if (own?.deviceId !== senderDeviceId) throw new CryptoError('NotMember', 'the sender has no leaf')
    if (!equalBytes(ed25519.getPublicKey(signatureKey), own.signatureKey)) throw new CryptoError('Malformed', 'the signature key is not the own leaf key')
    const kHist = await historyKey(handle)
    const keys = selectBundleKeys(s.groupContext.groupId, handle.epoch, entries)
    return sealBundle({ header: { groupId: s.groupContext.groupId, epoch: handle.epoch, senderLeaf: handle.ownLeaf, senderDeviceId }, kHist, signatureKey, keys })
  },

  async openHistoryBundle(handle, bundle, policy) {
    const s = stateOf(handle)
    const decoded = decodeBundleHeader(bundle)
    const h = decoded.header
    if (!equalBytes(h.groupId, s.groupContext.groupId)) throw new CryptoError('Malformed', 'history bundle of another group')
    if (h.epoch !== handle.epoch) throw new CryptoError('Malformed', 'history bundle of another epoch')
    const leaf = treeLeaves(s.ratchetTree)[h.senderLeaf]
    const entry = leaf === undefined ? null : leafEntry(leaf, h.senderLeaf)
    if (leaf === undefined || entry?.deviceId !== h.senderDeviceId) throw new CryptoError('Malformed', 'history bundle sender leaf')
    const v = checkLeafChain(leaf, (u) => policy.chainContextFor(u), false)
    if (!v.ok) throw new CryptoError('InvalidChain', `history bundle sender: ${v.reason}`)
    const keys = openBundle({ bundle: decoded, kHist: await historyKey(handle), senderKey: leaf.signaturePublicKey })
    return keys.map((k) => ({ groupId: s.groupContext.groupId, epoch: k.epoch, secret: k.secret }))
  },
}

/** K_hist = MLS-Exporter("hachiman history v1", group_id ‖ uint64(epoch), 32). */
function historyKey(handle: MlsGroupHandle): Promise<Uint8Array> {
  return mls.exporter(handle, ExporterLabel.HISTORY, concatBytes(handle.groupId, u64(handle.epoch)), EXPORTER_LENGTH)
}

/** S_e = MLS-Exporter("hachiman message v1", group_id, 32). */
export function messageSecret(handle: MlsGroupHandle): Promise<Uint8Array> {
  return mls.exporter(handle, ExporterLabel.MESSAGE, handle.groupId, EXPORTER_LENGTH)
}

function b64(x: { groupInfo: Uint8Array; ratchetTree: Uint8Array }): { groupInfo: string; ratchetTree: string } {
  return { groupInfo: toB64url(x.groupInfo), ratchetTree: toB64url(x.ratchetTree) }
}

