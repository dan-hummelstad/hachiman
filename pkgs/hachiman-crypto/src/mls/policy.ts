/**
 * The client side of the §12.7.3 policy table and the §12.6 GCE rules. Pure and synchronous:
 * ts-mls calls its commit callback synchronously, so every input (chain contexts, readers) is
 * prefetched into the ProposalPolicy.
 */
import type { ClientState, Extension, KeyPackage, LeafNode, Proposal, PublicMessage } from 'ts-mls'
import { bytesToBase64 } from 'ts-mls'

import type { ProposalPolicy, UserId } from '../api'
import { equalBytes } from '../identity/bytes'
import { identity } from '../identity/index'
import { checkContextLayout, checkGceChange, checkLeafChain, credentialText, leafEntry, sameMember, treeLeaves } from './wire'

/** A proposal of a commit, with its origin: by value (from the committer) or by reference. */
export interface PlacedProposal {
  proposal: Proposal
  byRef: boolean
  /** The sender of a stored proposal: undefined for the external sender. */
  refSender: number | undefined
}

function parseIdentity(leaf: { credential: LeafNode['credential'] }): { userId: UserId; deviceId: string; text: string } | null {
  const text = credentialText(leaf.credential)
  const id = text === null ? null : identity.parseCredentialIdentity(text)
  return id === null || text === null ? null : { ...id, text }
}

/** The proposals of a commit in list order. Throws when a reference is not in the state. */
export function placeProposals(state: ClientState, pm: PublicMessage): PlacedProposal[] {
  if (pm.content.contentType !== 'commit') return []
  return pm.content.commit.proposals.map((p) => {
    if (p.proposalOrRefType === 'proposal') return { proposal: p.proposal, byRef: false, refSender: undefined }
    const stored = state.unappliedProposals[bytesToBase64(p.reference)]
    if (stored === undefined) throw new Error('unknown proposal reference')
    return { proposal: stored.proposal, byRef: true, refSender: stored.senderLeafIndex }
  })
}

/** Add checks shared by every origin: chain (entering), readers and admin readers. Null when allowed. */
export function checkAddKeyPackage(kp: KeyPackage, policy: ProposalPolicy): string | null {
  const id = parseIdentity(kp.leafNode)
  if (id === null) return 'malformed_credential'
  const chain = checkLeafChain(kp.leafNode, (u) => policy.chainContextFor(u), true)
  if (!chain.ok) return `invalid_chain:${chain.reason}`
  if (policy.kind === 'voice') {
    if (!policy.voice?.pending.has(id.text)) return 'not_pending'
    return null
  }
  if (!policy.readers?.has(id.userId)) return 'not_reader'
  if (policy.adminChainMissing === true && policy.kind === 'channel') return 'admin_chain_missing'
  if (policy.adminReaders !== null && !policy.adminReaders.has(id.userId)) return 'not_admin_reader'
  return null
}

/**
 * The chain pre-check of §12.4 before processMessage: every Add key package, the update path leaf
 * and the external commit leaf. Also the group context layout. Null when the message may go on.
 */
export function precheck(state: ClientState, pm: PublicMessage, policy: ProposalPolicy): string | null {
  const layout = checkContextLayout(state.groupContext, { kind: policy.kind, dsExternalSenderKey: policy.dsExternalSenderKey })
  if (layout !== null) return `context:${layout}`
  const content = pm.content
  if (content.contentType === 'application') return 'application_message'
  if (content.contentType === 'proposal') {
    if (content.proposal.proposalType === 'add') return checkAddKeyPackage(content.proposal.add.keyPackage, policy)
    return null
  }
  let placed: PlacedProposal[]
  try {
    placed = placeProposals(state, pm)
  } catch {
    return 'unknown_reference'
  }
  for (const p of placed) {
    if (p.proposal.proposalType === 'add') {
      const why = checkAddKeyPackage(p.proposal.add.keyPackage, policy)
      if (why !== null) return why
    }
  }
  const path = content.commit.path
  if (content.sender.senderType === 'member') {
    if (path !== undefined) {
      // An update path cannot change the identity or the key of the committer leaf (§12.7.3 check 5).
      if (!sameMember(treeLeaves(state.ratchetTree)[content.sender.leafIndex], path.leafNode)) return 'path_changes_leaf'
      const v = checkLeafChain(path.leafNode, (u) => policy.chainContextFor(u), false)
      if (!v.ok) return `invalid_chain:${v.reason}`
    }
  } else if (content.sender.senderType === 'new_member_commit') {
    if (path === undefined) return 'external_commit_without_path'
    const v = checkLeafChain(path.leafNode, (u) => policy.chainContextFor(u), true)
    if (!v.ok) return `invalid_chain:${v.reason}`
  } else {
    return 'commit_sender'
  }
  return null
}

/** A standalone proposal (§12.7.3 row 1): only DS proposals, Add only in public_set, nothing in voice. */
export function evaluateProposal(state: ClientState, pm: PublicMessage, policy: ProposalPolicy): string | null {
  const content = pm.content
  if (content.contentType !== 'proposal') return 'not_proposal'
  if (content.sender.senderType !== 'external') return 'member_proposal'
  if (policy.kind === 'voice' || policy.dsExternalSenderKey === null) return 'ds_proposal_in_voice'
  if (content.sender.senderIndex !== 0) return 'external_sender_index'
  const p = content.proposal
  if (p.proposalType === 'remove') {
    return treeLeaves(state.ratchetTree)[p.remove.removed] === undefined ? 'remove_blank_leaf' : null
  }
  if (p.proposalType === 'add') {
    if (policy.kind !== 'public_set') return 'ds_add_outside_public_set'
    return checkAddKeyPackage(p.add.keyPackage, policy)
  }
  return 'proposal_type'
}

/** A commit (§12.7.3 rows 2-7). `placed` comes from placeProposals. */
export function evaluateCommit(state: ClientState, pm: PublicMessage, placed: readonly PlacedProposal[], policy: ProposalPolicy): string | null {
  const content = pm.content
  if (content.contentType !== 'commit') return 'not_commit'
  const leaves = treeLeaves(state.ratchetTree)

  if (content.sender.senderType === 'new_member_commit') {
    if (policy.kind === 'voice') return 'external_commit_in_voice'
    const newLeaf = content.commit.path?.leafNode
    const id = newLeaf === undefined ? null : parseIdentity(newLeaf)
    if (newLeaf === undefined || id === null) return 'external_commit_leaf'
    let removes = 0
    let hasInit = false
    for (const p of placed) {
      if (p.byRef) return 'external_commit_reference'
      if (p.proposal.proposalType === 'external_init') {
        hasInit = true
        continue
      }
      if (p.proposal.proposalType !== 'remove') return 'external_commit_proposal'
      removes++
      const old = leaves[p.proposal.remove.removed]
      const oldId = old === undefined ? null : parseIdentity(old)
      // Resync: the removed leaf is this device (same identity and key).
      if (old === undefined || oldId?.text !== id.text || !equalBytes(old.signaturePublicKey, newLeaf.signaturePublicKey)) return 'external_commit_remove'
    }
    if (!hasInit || removes > 1) return 'external_commit_shape'
    if (removes === 1) return null
    if (policy.kind === 'public_set') return policy.readers?.has(id.userId) ? null : 'not_reader'
    // channel / dm: only a user who already has a leaf (a new own device), or in a channel group the
    // new leaf that an accepted InviteAuth names (§12.11.4).
    const hasLeaf = leaves.some((l) => {
      const x = l === undefined ? null : parseIdentity(l)
      return x !== null && x.userId === id.userId
    })
    if (!hasLeaf) {
      const invited = policy.kind === 'channel' && policy.inviteJoinKey != null && equalBytes(policy.inviteJoinKey, newLeaf.signaturePublicKey)
      if (!invited) return 'external_join_without_leaf'
      if (policy.adminReaders !== null && !policy.adminReaders.has(id.userId)) return 'not_admin_reader'
    }
    return policy.readers?.has(id.userId) ? null : 'not_reader'
  }

  if (content.sender.senderType !== 'member') return 'commit_sender'
  const committerLeaf = leaves[content.sender.leafIndex]
  const committer = committerLeaf === undefined ? null : leafEntry(committerLeaf, content.sender.leafIndex)
  if (committer === null) return 'committer_leaf'

  for (const p of placed) {
    const prop = p.proposal
    if (p.byRef && p.refSender !== undefined) return 'member_proposal_reference'
    switch (prop.proposalType) {
      case 'add':
        if (p.byRef) {
          if (policy.kind !== 'public_set') return 'ds_add_outside_public_set'
        }
        // Chain, readers and admin readers ran in the pre-check.
        break
      case 'remove': {
        if (p.byRef) {
          if (policy.kind === 'voice') return 'ds_proposal_in_voice'
          break
        }
        const why = checkValueRemove(leaves, prop.remove.removed, committer.userId, policy)
        if (why !== null) return why
        break
      }
      case 'group_context_extensions': {
        if (p.byRef) return 'gce_reference'
        const why = checkGce(state, prop.groupContextExtensions.extensions, committer.userId, policy)
        if (why !== null) return why
        break
      }
      default:
        return `proposal_type:${String(prop.proposalType)}`
    }
  }
  return null
}

/** A Remove by value (§12.7.3 row 5): own devices, non-readers and revoked devices; `departed` in voice. */
export function checkValueRemove(leaves: readonly (LeafNode | undefined)[], removed: number, committerUserId: UserId, policy: ProposalPolicy): string | null {
  const target = leaves[removed]
  const t = target === undefined ? null : leafEntry(target, removed)
  if (t === null) return 'remove_blank_leaf'
  if (policy.kind === 'voice') {
    return policy.voice?.departedDeviceIds.has(t.deviceId) ? null : 'remove_not_departed'
  }
  const own = t.userId === committerUserId
  const nonReader = policy.readers !== null && !policy.readers.has(t.userId)
  const revoked = policy.chainContextFor(t.userId).revokedDeviceIds.has(t.deviceId)
  return own || nonReader || revoked ? null : 'illegal_remove'
}

/** A GroupContextExtensions commit (§12.6): channel and public_set only, by a permitted user, history_visibility only. */
export function checkGce(state: ClientState, next: readonly Extension[], committerUserId: UserId, policy: ProposalPolicy): string | null {
  if (policy.kind !== 'channel' && policy.kind !== 'public_set') return 'gce_kind'
  if (!policy.canChangeDescriptor(committerUserId)) return 'gce_permission'
  return checkGceChange(state.groupContext.extensions, next)
}
