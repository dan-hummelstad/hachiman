/**
 * DsModule (docs/gateway-protocol.md §12.7, §12.18): the Node entry that Takusen imports as
 * `@hachiman/crypto/ds`. It signs external proposals and checks uploads without group secrets.
 *
 * The import graph uses only globalThis.crypto. It does not reach src/attachments, src/store,
 * src/worker, src/bridge or src/media.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  type CiphersuiteImpl,
  type GroupInfo,
  type LeafNode,
  type Proposal,
  type PublicMessage,
  type RatchetTree,
  encodeExternalSender,
  proposeExternal,
} from 'ts-mls'
import { makeProposalRef } from 'ts-mls/authenticatedContent.js'
import { nextEpochContext } from 'ts-mls/clientState.js'
import { verifyFramedContentSignature } from 'ts-mls/framedContent.js'
import { verifyGroupInfoSignature } from 'ts-mls/groupInfo.js'
import { makeKeyPackageRef, verifyKeyPackage } from 'ts-mls/keyPackage.js'
import { verifyLeafNodeSignatureKeyPackage } from 'ts-mls/leafNode.js'
import { addLeafNode, removeLeafNode } from 'ts-mls/ratchetTree.js'
import { treeHashRoot } from 'ts-mls/treeHash.js'
import { toLeafIndex } from 'ts-mls/treemath.js'

import { CryptoError, type CommitCheck, type CommitInspection, type DeviceChain, type DsModule, type DsSigner, type GroupInfoInspection, type UserId } from '../api'
import { admin } from '../admin/index'
import { envelope } from '../envelope/index'
import { verifyFrankingSync } from '../franking/index'
import { equalBytes } from '../identity/bytes'
import { identity, verifyDeviceCert, verifyDskCert, verifyMasterSelfSignature } from '../identity/index'
import { kt } from '../kt/index'
import {
  DS_CREDENTIAL_IDENTITY,
  bigintEpoch,
  credentialText,
  decodeGroupInfoMessage,
  decodeKeyPackageMessage,
  decodePublicMessage,
  decodeTree,
  encodePublic as encodePublicBytes,
  leafChain,
  readContextExtensions,
  rosterOfTree,
  sameLeafBytes,
  sameMember,
  suite,
  suiteId,
  treeLeaves,
} from './wire'

const te = new TextEncoder()

type ProposalTypeName = CommitInspection['proposalTypes'][number]

function typeName(p: Proposal): ProposalTypeName {
  switch (p.proposalType) {
    case 'add':
    case 'remove':
    case 'update':
    case 'external_init':
    case 'group_context_extensions':
    case 'psk':
    case 'reinit':
      return p.proposalType
    default:
      return 'other'
  }
}

/** The master public key that Takusen holds: 32 raw bytes or an encoded MasterKeyRecord. */
function masterPublicKey(v: Uint8Array | null): Uint8Array | null {
  if (v === null) return null
  if (v.length === 32) return v
  try {
    return identity.decodeMasterKeyRecord(v).publicKey
  } catch {
    return null
  }
}

/** Check 7: identity, chain signatures and the leaf key. No TOFU, no revocation (Takusen has the rows). */
function leafChainValid(leaf: LeafNode, masterKeys: (userId: UserId) => Uint8Array | null, nowMs: number): string | null {
  const text = credentialText(leaf.credential)
  const id = text === null ? null : identity.parseCredentialIdentity(text)
  if (text === null || id === null) return 'credential'
  const chain = leafChain(leaf)
  if (chain === null) return 'chain_missing'
  const master = masterPublicKey(masterKeys(id.userId))
  if (master === null) return 'unknown_user'
  return chainSignaturesValid(chain, master, { credentialIdentity: text, signatureKey: leaf.signaturePublicKey }, nowMs)
}

function chainSignaturesValid(chain: DeviceChain, master: Uint8Array, leaf: { credentialIdentity: string; signatureKey: Uint8Array }, nowMs: number): string | null {
  const v = identity.verifyChain(chain, {
    pinnedMaster: { publicKey: master, generation: chain.master.generation },
    currentDsk: { generation: chain.dsk.generation, issuedAtMs: chain.dsk.issuedAtMs },
    highestSeenDskGeneration: null,
    revokedDeviceIds: new Set(),
    leaf,
    entering: false,
    nowMs,
  })
  return v.ok ? null : `chain:${v.reason}`
}

interface Decoded {
  gi: GroupInfo
  tree: RatchetTree
  cs: CiphersuiteImpl
}

async function decodeState(groupInfo: Uint8Array, ratchetTree: Uint8Array): Promise<Decoded> {
  const gi = decodeGroupInfoMessage(groupInfo)
  const tree = decodeTree(ratchetTree)
  const cs = await suite(suiteId(gi.groupContext.cipherSuite))
  return { gi, tree, cs }
}

async function signatureAndHash(d: Decoded): Promise<{ signatureValid: boolean; treeHashValid: boolean }> {
  const signer = treeLeaves(d.tree)[d.gi.signer]
  const signatureValid = signer !== undefined && (await verifyGroupInfoSignature(d.gi, signer.signaturePublicKey, d.cs.signature).catch(() => false))
  const treeHashValid = equalBytes(await treeHashRoot(d.tree, d.cs.hash), d.gi.groupContext.treeHash)
  return { signatureValid, treeHashValid }
}

/** Applies a Remove or an Add to a tree the way ts-mls does (leftmost blank leaf, then extend). */
function applyRemove(tree: RatchetTree, leaf: number): RatchetTree {
  if (treeLeaves(tree)[leaf] === undefined) throw new Error(`remove of blank leaf ${leaf}`)
  return removeLeafNode(tree, toLeafIndex(leaf))
}

function blankLeafSlots(tree: RatchetTree, count: number): number[] {
  const leaves = treeLeaves(tree)
  const out: number[] = []
  for (let i = 0; out.length < count; i++) if (i >= leaves.length || leaves[i] === undefined) out.push(i)
  return out
}

async function checkCommit(input: Parameters<DsModule['checkCommit']>[0]): Promise<CommitCheck> {
  const fail = (reason: string): CommitCheck => ({ ok: false, reason })
  const nowMs = Date.now()

  // 2. Framing, group, epoch.
  let pm: PublicMessage
  try {
    pm = decodePublicMessage(input.commit)
  } catch {
    return fail('framing: not a PublicMessage')
  }
  const c = pm.content
  if (c.contentType !== 'commit') return fail('framing: not a commit')
  if (!equalBytes(c.groupId, input.groupId)) return fail('group_id')
  if (c.epoch !== BigInt(input.epoch)) return fail('epoch')

  let prev: Decoded
  let next: Decoded
  try {
    prev = await decodeState(input.previous.groupInfo, input.previous.ratchetTree)
    next = await decodeState(input.groupInfo, input.ratchetTree)
  } catch (e) {
    return fail(`group_info: ${(e as Error).message}`)
  }
  if (!equalBytes(prev.gi.groupContext.groupId, input.groupId) || prev.gi.groupContext.epoch !== BigInt(input.epoch)) return fail('previous: stored state is not this epoch')
  const cs = prev.cs
  if (next.gi.groupContext.cipherSuite !== prev.gi.groupContext.cipherSuite) return fail('cipher_suite')
  const prevLeaves = treeLeaves(prev.tree)
  const nextLeaves = treeLeaves(next.tree)
  const senderIdentity = identity.credentialIdentity(input.sender.userId, input.sender.deviceId)

  // 3. The sender is the request device, and the commit signature is valid under its key.
  let committerLeaf: LeafNode | undefined
  let committerIndex: number
  let sender: CommitInspection['sender']
  if (c.sender.senderType === 'member') {
    committerIndex = c.sender.leafIndex
    committerLeaf = prevLeaves[committerIndex]
    sender = { type: 'member', leafIndex: committerIndex }
  } else if (c.sender.senderType === 'new_member_commit') {
    committerLeaf = c.commit.path?.leafNode
    committerIndex = -1
    sender = { type: 'new_member_commit' }
  } else {
    return fail('sender: not a member or an external commit')
  }
  if (committerLeaf === undefined) return fail('sender: no leaf')
  if (credentialText(committerLeaf.credential) !== senderIdentity) return fail('sender: credential is not the request device')
  const sigOk = await verifyFramedContentSignature(committerLeaf.signaturePublicKey, 'mls_public_message', c, pm.auth, prev.gi.groupContext, cs.signature).catch(() => false)
  if (!sigOk) return fail('sender: commit signature')

  // 6. Proposal references: each one a DS proposal that Takusen published for this epoch.
  const published = new Map<string, Proposal | null>()
  for (const item of input.publishedProposalRefs) {
    if (item.length === cs.kdf.size) {
      const k = hex(item)
      if (!published.has(k)) published.set(k, null)
      continue
    }
    // A full MLSMessage proposal also works: then the transition below is exact.
    try {
      const p = decodePublicMessage(item)
      if (p.content.contentType !== 'proposal') continue
      const ref = await makeProposalRef({ wireformat: 'mls_public_message', content: p.content, auth: p.auth }, cs.hash)
      published.set(hex(ref), p.content.proposal)
    } catch {
      continue
    }
  }
  const proposalTypes: ProposalTypeName[] = []
  const proposalRefs: Uint8Array[] = []
  const valueRemoves: number[] = []
  const valueAdds: LeafNode[] = []
  const knownRefRemoves: number[] = []
  /** Known Adds (by value and by known ref) in list order: ts-mls fills blanks in this order. */
  const knownAdds: LeafNode[] = []
  let unknownRefs = 0
  let externalInit = 0
  let descriptorChanged = false
  for (const p of c.commit.proposals) {
    if (p.proposalOrRefType === 'reference') {
      proposalRefs.push(p.reference)
      const k = hex(p.reference)
      if (!published.has(k)) return fail('proposal_ref: not a published DS proposal')
      const known = published.get(k) ?? null
      if (known === null) {
        unknownRefs++
        continue
      }
      proposalTypes.push(typeName(known))
      if (known.proposalType === 'remove') knownRefRemoves.push(known.remove.removed)
      else if (known.proposalType === 'add') knownAdds.push(known.add.keyPackage.leafNode)
      else return fail('proposal_ref: a DS proposal is only Add or Remove')
      continue
    }
    const prop = p.proposal
    proposalTypes.push(typeName(prop))
    switch (prop.proposalType) {
      case 'remove':
        valueRemoves.push(prop.remove.removed)
        break
      case 'add':
        valueAdds.push(prop.add.keyPackage.leafNode)
        knownAdds.push(prop.add.keyPackage.leafNode)
        break
      case 'external_init':
        externalInit++
        break
      case 'group_context_extensions':
        descriptorChanged = true
        break
      default:
        return fail(`proposals: ${String(prop.proposalType)} is not allowed`)
    }
  }
  if (c.sender.senderType === 'new_member_commit') {
    if (externalInit !== 1 || valueAdds.length > 0 || descriptorChanged || proposalRefs.length > 0 || valueRemoves.length > 1) return fail('external_commit: proposals')
  } else if (externalInit > 0) {
    return fail('proposals: external_init in a member commit')
  }

  // 4. GroupInfo of epoch + 1: epoch, external_pub, tree hash, signature by the committer.
  if (!equalBytes(next.gi.groupContext.groupId, input.groupId)) return fail('group_info: group id')
  if (next.gi.groupContext.epoch !== BigInt(input.epoch) + 1n) return fail('group_info: epoch')
  const hasExternalPub = next.gi.extensions.some((e) => e.extensionType === 'external_pub')
  if (!hasExternalPub) return fail('group_info: external_pub missing')
  const { signatureValid, treeHashValid } = await signatureAndHash(next)
  if (!treeHashValid) return fail('group_info: tree hash')
  if (!signatureValid) return fail('group_info: signature')
  const signerLeaf = nextLeaves[next.gi.signer]
  if (signerLeaf === undefined || credentialText(signerLeaf.credential) !== senderIdentity || !equalBytes(signerLeaf.signaturePublicKey, committerLeaf.signaturePublicKey)) {
    return fail('group_info: the signer is not the committer')
  }
  if (c.sender.senderType === 'member' && next.gi.signer !== committerIndex) return fail('group_info: the signer leaf moved')

  // The confirmed transcript hash binds the GroupInfo to this commit and the previous epoch.
  const prevExt = readContextExtensions(prev.gi.groupContext.extensions)
  const nextExt = readContextExtensions(next.gi.groupContext.extensions)
  const extsSame =
    prev.gi.groupContext.extensions.length === next.gi.groupContext.extensions.length &&
    prev.gi.groupContext.extensions.every((e, i) => equalBytes(e.extensionData, next.gi.groupContext.extensions[i]!.extensionData) && e.extensionType === next.gi.groupContext.extensions[i]!.extensionType)
  if (!descriptorChanged && !extsSame) return fail('group_info: extensions changed without a GCE proposal')
  if (pm.auth.contentType !== 'commit') return fail('framing: auth')
  const expected = await nextEpochContext(
    { ...prev.gi.groupContext, extensions: next.gi.groupContext.extensions },
    'mls_public_message',
    c,
    pm.auth.signature,
    next.gi.groupContext.treeHash,
    prev.gi.confirmationTag,
    cs.hash,
  )
  if (!equalBytes(expected.confirmedTranscriptHash, next.gi.groupContext.confirmedTranscriptHash)) return fail('group_info: transcript hash does not follow the commit')
  if (descriptorChanged) {
    // §12.6: only history_visibility may change.
    if (prevExt.types.join() !== nextExt.types.join()) return fail('gce: extension order')
    if (!sameBytes(prevExt.externalSenders, nextExt.externalSenders)) return fail('gce: external_senders')
    if (!sameBytes(prevExt.requiredCapabilities, nextExt.requiredCapabilities)) return fail('gce: required_capabilities')
    const a = prevExt.descriptor
    const b = nextExt.descriptor
    if (a === null || b === null) return fail('gce: descriptor')
    if (a.kind !== b.kind || a.guildId !== b.guildId || a.channelId !== b.channelId || a.createdByUserId !== b.createdByUserId) return fail('gce: descriptor')
  }

  // 5. Roster transition from `previous`.
  let expectedTree = prev.tree
  try {
    if (c.sender.senderType === 'new_member_commit') {
      const newLeaf = committerLeaf
      for (const r of valueRemoves) {
        // Only the resync Remove of the device's own former leaf.
        const old = prevLeaves[r]
        if (!sameMember(old, newLeaf)) return fail('external_commit: the Remove is not a resync of the own leaf')
        expectedTree = applyRemove(expectedTree, r)
      }
      expectedTree = addLeafNode(expectedTree, newLeaf)[0]
      const got = transitionMatches(expectedTree, next.tree)
      if (got !== null) return fail(`roster: ${got}`)
    } else {
      for (const r of [...knownRefRemoves, ...valueRemoves]) expectedTree = applyRemove(expectedTree, r)
      if (unknownRefs === 0) {
        for (const leaf of knownAdds) expectedTree = addLeafNode(expectedTree, leaf)[0]
        const got = transitionMatches(expectedTree, next.tree)
        if (got !== null) return fail(`roster: ${got}`)
      } else {
        // Only refs were given: each unknown ref is one Remove or one Add of a key package leaf.
        const why = inferTransition(expectedTree, nextLeaves, knownAdds, unknownRefs, committerIndex)
        if (why !== null) return fail(`roster: ${why}`)
      }
    }
  } catch (e) {
    return fail(`roster: ${(e as Error).message}`)
  }

  // 7. New and changed leaves: identity and chain signatures.
  const changedLeaves: number[] = []
  const removedLeaves: number[] = []
  for (let i = 0; i < Math.max(prevLeaves.length, nextLeaves.length); i++) {
    const a = prevLeaves[i]
    const b = nextLeaves[i]
    if (a !== undefined && !sameMember(a, b)) removedLeaves.push(i)
    if (b !== undefined && !sameLeafBytes(a, b)) {
      changedLeaves.push(i)
      const why = leafChainValid(b, input.masterKeys, nowMs)
      if (why !== null) return fail(`leaf ${i}: ${why}`)
    }
  }

  const inspection: CommitInspection = {
    groupId: input.groupId,
    epoch: input.epoch,
    sender,
    proposalTypes,
    proposalRefs,
    next: { epoch: bigintEpoch(next.gi.groupContext.epoch), roster: rosterOfTree(next.tree), descriptor: nextExt.descriptor, signerLeaf: next.gi.signer, hasExternalPub },
    changedLeaves,
    removedLeaves,
    descriptorChanged,
  }
  return { ok: true, inspection }
}

/** The uploaded leaves equal the expected leaves (identity and signature key per index). */
function transitionMatches(expected: RatchetTree, got: RatchetTree): string | null {
  const a = treeLeaves(expected)
  const b = treeLeaves(got)
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (!sameMember(a[i], b[i])) return `leaf ${i} does not follow from the proposals`
  return null
}

/**
 * Refs without contents: every leaf that changed must be explained by a known Remove or Add, or
 * by one unknown ref (a Remove of a leaf, or an Add of a key package leaf into the next blank slot).
 */
function inferTransition(
  afterKnownRemoves: RatchetTree,
  nextLeaves: readonly (LeafNode | undefined)[],
  knownAdds: readonly LeafNode[],
  unknownRefs: number,
  committerIndex: number,
): string | null {
  const known = treeLeaves(afterKnownRemoves)
  // Leaves that the known removes kept but the next tree removed or replaced: inferred ref Removes.
  let inferredRemoves = 0
  let base = afterKnownRemoves
  for (let i = 0; i < known.length; i++) {
    const k = known[i]
    if (k === undefined) continue
    if (sameMember(k, nextLeaves[i])) continue
    if (i === committerIndex) return 'the committer leaf changed identity or key'
    base = applyRemove(base, i)
    inferredRemoves++
  }
  // New leaves fill the leftmost blank slots of `base`, in order.
  const added = nextLeaves.map((l, i) => ({ l, i })).filter(({ l, i }) => l !== undefined && !sameMember(treeLeaves(base)[i], l))
  const slots = blankLeafSlots(base, added.length)
  if (added.some((x, j) => x.i !== slots[j])) return 'added leaves are not in the leftmost blank slots'
  const pending = [...knownAdds]
  let inferredAdds = 0
  for (const { l } of added) {
    const j = pending.findIndex((p) => sameMember(p, l))
    if (j >= 0) {
      pending.splice(j, 1)
      continue
    }
    if (l!.leafNodeSource !== 'key_package') return 'an added leaf is not from a key package'
    inferredAdds++
  }
  if (pending.length > 0) return 'an Add by value is missing from the tree'
  // Leaves outside `added` must be unchanged.
  const baseLeaves = treeLeaves(base)
  for (let i = 0; i < Math.max(baseLeaves.length, nextLeaves.length); i++) {
    if (added.some((x) => x.i === i)) continue
    if (!sameMember(baseLeaves[i], nextLeaves[i])) return `leaf ${i} does not follow from the proposals`
  }
  if (inferredRemoves + inferredAdds !== unknownRefs) return 'the tree changes more leaves than the proposals'
  return null
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b
  return equalBytes(a, b)
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

async function inspectGroupInfo(groupInfo: Uint8Array, ratchetTree: Uint8Array): Promise<GroupInfoInspection> {
  const d = await decodeState(groupInfo, ratchetTree)
  const { signatureValid, treeHashValid } = await signatureAndHash(d)
  const e = readContextExtensions(d.gi.groupContext.extensions)
  return {
    groupId: d.gi.groupContext.groupId,
    epoch: bigintEpoch(d.gi.groupContext.epoch),
    cipherSuite: suiteId(d.gi.groupContext.cipherSuite),
    signatureValid,
    treeHashValid,
    roster: rosterOfTree(d.tree),
    extensions: { types: e.types, externalSenders: e.externalSenders, requiredCapabilities: e.requiredCapabilities },
    descriptor: e.descriptor,
  }
}

async function propose(signer: DsSigner, groupInfo: Uint8Array, proposal: Proposal): Promise<Uint8Array> {
  const gi = decodeGroupInfoMessage(groupInfo)
  const cs = await suite(suiteId(gi.groupContext.cipherSuite))
  try {
    const m = await proposeExternal(gi, proposal, signer.publicKey, signer.privateKey, cs)
    return encodeMessageBytes(m)
  } catch (e) {
    throw new CryptoError('Malformed', `proposeExternal: ${(e as Error).message}`)
  }
}

function encodeMessageBytes(m: Awaited<ReturnType<typeof proposeExternal>>): Uint8Array {
  if (m.wireformat !== 'mls_public_message') throw new CryptoError('Malformed', 'external proposal is not a PublicMessage')
  return encodePublicBytes(m.publicMessage)
}


export const ds: DsModule = {
  loadSigner(seed) {
    if (seed.length !== 32) return Promise.reject(new CryptoError('Malformed', 'the DS seed must be 32 bytes'))
    const publicKey = ed25519.getPublicKey(seed)
    const externalSender = encodeExternalSender({ signaturePublicKey: publicKey, credential: { credentialType: 'basic', identity: te.encode(DS_CREDENTIAL_IDENTITY) } })
    return Promise.resolve({ publicKey, privateKey: seed.slice(), externalSender })
  },

  proposeRemove(signer, groupInfo, leafIndex) {
    return propose(signer, groupInfo, { proposalType: 'remove', remove: { removed: leafIndex } })
  },

  async proposeAdd(signer, groupInfo, keyPackage) {
    const gi = decodeGroupInfoMessage(groupInfo)
    const d = readContextExtensions(gi.groupContext.extensions).descriptor
    if (d?.kind !== 'public_set') throw new CryptoError('Unsupported', 'DS Add proposals are for public_set groups only')
    return propose(signer, groupInfo, { proposalType: 'add', add: { keyPackage: decodeKeyPackageMessage(keyPackage) } })
  },

  async proposalRef(message, cipherSuite) {
    const pm = decodePublicMessage(message)
    if (pm.content.contentType !== 'proposal') throw new CryptoError('Malformed', 'not a proposal')
    const cs = await suite(cipherSuite)
    return makeProposalRef({ wireformat: 'mls_public_message', content: pm.content, auth: pm.auth }, cs.hash)
  },

  async inspectKeyPackage(bytes) {
    const kp = decodeKeyPackageMessage(bytes)
    const cs = await suite(suiteId(kp.cipherSuite))
    const text = credentialText(kp.leafNode.credential)
    const id = text === null ? null : identity.parseCredentialIdentity(text)
    if (id === null) throw new CryptoError('Malformed', 'key package credential is not userId:deviceId')
    const signatureValid = (await verifyKeyPackage(kp, cs.signature).catch(() => false)) && (await verifyLeafNodeSignatureKeyPackage(kp.leafNode, cs.signature).catch(() => false))
    const notAfter = kp.leafNode.lifetime.notAfter * 1000n
    return {
      ref: await makeKeyPackageRef(kp, cs.hash),
      cipherSuite: suiteId(kp.cipherSuite),
      userId: id.userId,
      deviceId: id.deviceId,
      signatureKey: kp.leafNode.signaturePublicKey,
      chain: leafChain(kp.leafNode),
      notAfterMs: notAfter > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(notAfter),
      signatureValid,
    }
  },

  checkCommit,
  inspectGroupInfo,

  rosterOf(groupInfo, ratchetTree) {
    try {
      decodeGroupInfoMessage(groupInfo)
      return Promise.resolve(rosterOfTree(decodeTree(ratchetTree)))
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)))
    }
  },

  verifyDeviceCertificate(cert, dsk, master) {
    try {
      const m = identity.decodeMasterKeyRecord(master)
      const d = identity.decodeDskCert(dsk)
      const c = identity.decodeDeviceCertificate(cert)
      return verifyMasterSelfSignature(m) && verifyDskCert(d, m) && verifyDeviceCert(c, d) ? c : null
    } catch {
      return null
    }
  },

  verifyMasterKeyRecord(record, prev) {
    try {
      const r = identity.decodeMasterKeyRecord(record)
      const p = prev === null ? null : identity.decodeMasterKeyRecord(prev)
      if (p !== null && p.userId !== r.userId) return null
      return identity.verifyMasterKeyRecord(r, p === null ? null : p.publicKey) ? r : null
    } catch {
      return null
    }
  },

  verifyDskCert(cert, master) {
    try {
      const m = identity.decodeMasterKeyRecord(master)
      const c = identity.decodeDskCert(cert)
      return verifyMasterSelfSignature(m) && verifyDskCert(c, m) ? c : null
    } catch {
      return null
    }
  },

  verifyRevocation(revocation, keys) {
    try {
      const r = identity.decodeRevocation(revocation)
      const master = identity.decodeMasterKeyRecord(keys.master)
      const device = keys.deviceCertificate === null ? null : identity.decodeDeviceCertificate(keys.deviceCertificate)
      return identity.verifyRevocation(r, { master, device }) ? r : null
    } catch {
      return null
    }
  },

  verifyAdminAction(action, actorCertificate) {
    try {
      const a = admin.decodeAction(action)
      const cert = identity.decodeDeviceCertificate(actorCertificate)
      return admin.verify(a, cert) ? a : null
    } catch {
      return null
    }
  },

  adminActionHash(action) {
    return admin.hash(admin.decodeAction(action))
  },

  parseEnvelopeHeader(bytes) {
    return envelope.decodeHeader(bytes).header
  },

  verifyFrankingOpening(input) {
    return verifyFrankingSync(input)
  },

  kt,
}
