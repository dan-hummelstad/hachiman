/**
 * Request body schemas of the commit and batch-decline routes (§12.12), in
 * lib/ so that the fuzz tests (`__fuzz__/`) can parse with them directly. A
 * Next route file may export only its handlers.
 */
import { z } from 'zod'

import { ApiError } from '@/lib/errors'

import { b64 } from './bytes'
import type { RejectedProposal } from './batches'
import { INBOX_ITEM_MAX_BYTES } from './config'

const MIB = 1024 * 1024
const MAX_REJECTIONS = 200

export const REJECT_REASON = z.enum(['invalid_chain', 'not_reader', 'revoked', 'policy', 'malformed'])
export type RejectReason = z.infer<typeof REJECT_REASON>

const rejectedProposal = z.object({ proposalRef: b64(64), reason: REJECT_REASON }).strict()

/**
 * POST /mls/groups/:groupId/commits. `rejected[]` is a BatchRejection: a join
 * by `pendingId`, or a DS Add proposal of the batch by `proposalRef`.
 * `rejectedProposals` is the older form of the second kind.
 */
export const commitRequestSchema = z.object({
  epoch: z.number().int().nonnegative(),
  commit: b64(MIB),
  groupInfo: b64(64 * 1024),
  ratchetTree: b64(8 * MIB),
  welcome: b64(INBOX_ITEM_MAX_BYTES).nullable(),
  batchId: z.string().uuid().nullable(),
  rejected: z
    .array(z.union([z.object({ pendingId: z.string().uuid(), reason: REJECT_REASON }).strict(), rejectedProposal]))
    .max(MAX_REJECTIONS),
  rejectedProposals: z.array(rejectedProposal).max(MAX_REJECTIONS).default([]),
})
export type CommitRequestBody = z.infer<typeof commitRequestSchema>

/** POST /mls/batches/:id/decline. */
export const declineBatchSchema = z.object({
  reason: z.enum(['not_synced', 'busy']),
  rejectedProposals: z.array(rejectedProposal).max(MAX_REJECTIONS).default([]),
})

/** Splits `rejected[]` by kind and merges the `proposalRef` entries into `rejectedProposals`. */
export function splitRejections(body: Pick<CommitRequestBody, 'rejected' | 'rejectedProposals'>): {
  rejected: { pendingId: string; reason: RejectReason }[]
  rejectedProposals: RejectedProposal[]
} {
  const rejected: { pendingId: string; reason: RejectReason }[] = []
  const rejectedProposals: RejectedProposal[] = [...body.rejectedProposals]
  for (const x of body.rejected) {
    if ('pendingId' in x) rejected.push(x)
    else rejectedProposals.push(x)
  }
  if (rejectedProposals.length > MAX_REJECTIONS) throw new ApiError('ValidationError', 400, `at most ${MAX_REJECTIONS} rejected proposals`)
  return { rejected, rejectedProposals }
}
