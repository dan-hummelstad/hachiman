/**
 * DS proposals (docs/gateway-protocol.md §12.7.4). Takusen signs exactly one
 * external proposal per pending item and epoch: a Remove for each queued
 * Remove, an Add for each queued `public_set` Add. It appends the proposal to
 * the handshake stream and emits MLS_HANDSHAKE before any batch uses it.
 *
 * Every signer holds the group row lock (MlsRepo.lockGroup), the same lock as
 * the commit compare-and-set. Thus a proposal is never signed twice for one
 * epoch, and never for an epoch that a commit has just ended.
 */
import type { DsDeps } from './context'
import { emitToGroup, handshakeEvent, type Outbox } from './events'
import type { GroupRow, MlsRepo } from './repo'

/** Signs the missing proposals of one group in its own transaction. */
export async function signPendingProposals(repo: MlsRepo, deps: Pick<DsDeps, 'ds' | 'signer'>, out: Outbox, groupId: Uint8Array): Promise<void> {
  await repo.transaction(async (r) => {
    const group = await r.lockGroup(groupId)
    if (group) await signProposalsLocked(r, deps, out, group)
  })
}

/** The caller holds the group lock, and `group` is the locked row. */
export async function signProposalsLocked(r: MlsRepo, deps: Pick<DsDeps, 'ds' | 'signer'>, out: Outbox, group: GroupRow): Promise<number> {
  if (group.status !== 'active' || group.epoch === null || !group.groupInfo) return 0
  const items = await r.listPending(group.groupId, ['queued', 'assigned'])
  const members = await r.listMembers(group.groupId)
  let signed = 0
  for (const p of items) {
    if (p.op === 'add' && group.kind !== 'public_set') continue // Adds by value need no proposal
    if (p.proposal && p.proposalEpoch === group.epoch) continue
    let message: Uint8Array
    if (p.op === 'remove') {
      const leaf = p.leafIndex === null ? undefined : members.find((m) => m.leafIndex === p.leafIndex)
      // The leaf is gone, or another device took the index: the Remove has nothing left to do.
      if (!leaf || (p.deviceId !== null && leaf.deviceId !== null && leaf.deviceId !== p.deviceId)) {
        await r.deletePending([p.id])
        continue
      }
      message = await deps.ds.proposeRemove(deps.signer, group.groupInfo, leaf.leafIndex)
    } else {
      if (!p.keyPackage) continue
      message = await deps.ds.proposeAdd(deps.signer, group.groupInfo, p.keyPackage)
    }
    const ref = await deps.ds.proposalRef(message, group.cipherSuite as Parameters<DsDeps['ds']['proposalRef']>[1])
    await r.updatePending(p.id, { proposal: message, proposalEpoch: group.epoch, proposalRef: ref })
    const h = { groupId: group.groupId, epoch: group.epoch, kind: 'proposal' as const, senderDevice: null, message, treeHash: null, confirmedTranscriptHash: null }
    const seq = await r.appendHandshake(h)
    await emitToGroup(r, out, group, 'MLS_HANDSHAKE', handshakeEvent({ ...h, seq }))
    signed++
  }
  return signed
}
