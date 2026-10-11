/**
 * Envelope checks on send and edit (docs/gateway-protocol.md §12.8.4). Takusen
 * decodes only the header. It never decrypts.
 */
import type { Tx } from '@/db/client'
import { ApiError } from '@/lib/errors'

import { bytesEqual } from './bytes'
import { dsConfig } from './config'
import { ADD_ONLY_EPOCH_GRACE_MS, getDsModule, type DsModule, type EnvelopeHeader } from './crypto'
import type { DocEnvelopeHeader } from '@hachiman/crypto'
import { drizzleMlsRepo } from './repo.drizzle'
import type { MlsRepo } from './repo'

interface EnvelopeInputBase {
  channelId: string
  userId: string
  /** The X-Hachiman-Device of the request. */
  deviceId: string
  envelope: Uint8Array
}

/**
 * `edit: true` carries the `client_msg_id` of the stored row: the edit header
 * must repeat it (§12.8.6), and the uniqueness check is skipped.
 */
export type EnvelopeInput = (EnvelopeInputBase & { edit: false }) | (EnvelopeInputBase & { edit: true; rowClientMsgId: Uint8Array })

export interface AcceptedEnvelope {
  groupId: Uint8Array
  epoch: number
  senderDeviceId: string
  clientMsgId: Uint8Array
  frankingTag: Uint8Array
  size: number
}

/** Call inside the message route transaction. Throws ApiError (§12.8.4, §12.19). */
export async function acceptEnvelope(tx: Tx, input: EnvelopeInput): Promise<AcceptedEnvelope> {
  return acceptEnvelopeWith(drizzleMlsRepo(tx), { ds: await getDsModule(), maxEnvelopeBytes: dsConfig().maxEnvelopeBytes, now: new Date() }, input)
}

export async function acceptEnvelopeWith(
  repo: MlsRepo,
  deps: { ds: Pick<DsModule, 'parseEnvelopeHeader'>; maxEnvelopeBytes: number; now: Date },
  input: EnvelopeInput,
): Promise<AcceptedEnvelope> {
  if (input.envelope.length > deps.maxEnvelopeBytes) {
    throw new ApiError('EnvelopeTooLarge', 413, `the envelope is above ${deps.maxEnvelopeBytes} bytes`)
  }
  let header: EnvelopeHeader
  try {
    header = deps.ds.parseEnvelopeHeader(input.envelope)
  } catch {
    throw new ApiError('InvalidEnvelope', 400, 'the envelope header does not decode')
  }

  const groupId = await checkGroupHeader(repo, deps.now, input, header)

  if (input.edit) {
    if (!bytesEqual(header.clientMsgId, input.rowClientMsgId)) {
      throw new ApiError('InvalidEnvelope', 400, 'an edit keeps the client_msg_id of the original')
    }
  } else if (await repo.messageClientMsgIdExists(input.channelId, header.clientMsgId)) {
    throw new ApiError('DuplicateMessage', 409, 'the client_msg_id exists in the channel')
  }

  return {
    groupId,
    epoch: header.epoch,
    senderDeviceId: input.deviceId,
    clientMsgId: header.clientMsgId,
    frankingTag: header.frankingTag,
    size: input.envelope.length,
  }
}

/**
 * The checks that a message envelope and a page envelope share (§12.8.4, §12.20): the current
 * and active group of the channel, the channel, the epoch rule, and the sender device and leaf.
 * Returns the group id.
 */
async function checkGroupHeader(
  repo: MlsRepo,
  now: Date,
  input: EnvelopeInputBase,
  header: Pick<EnvelopeHeader, 'groupId' | 'channelId' | 'epoch' | 'senderLeaf' | 'senderDeviceId'>,
): Promise<Uint8Array> {
  const channel = await repo.getChannel(input.channelId)
  if (!channel) throw new ApiError('NotFound', 404, 'unknown channel')
  const group = channel.mlsGroupId ? await repo.getGroup(channel.mlsGroupId) : null
  if (!group || group.status === 'pending' || group.epoch === null) throw new ApiError('GroupPending', 409, 'the group of the channel is not active yet')
  if (group.status !== 'active') throw new ApiError('GroupPending', 409, 'the channel has no active group')
  if (!bytesEqual(header.groupId, group.groupId)) throw new ApiError('InvalidEnvelope', 400, 'the envelope is for another group')
  if (header.channelId !== input.channelId) throw new ApiError('InvalidEnvelope', 400, 'the envelope is for another channel')

  // §12.8.4: the stored epoch, or the epoch before it when the newest commit
  // removed no leaf of another device and is less than 10 s old.
  const graceOk =
    header.epoch === group.epoch - 1 &&
    !group.lastCommitRemoved &&
    group.epochStartedAt !== null &&
    now.getTime() - group.epochStartedAt.getTime() < ADD_ONLY_EPOCH_GRACE_MS
  if (header.epoch !== group.epoch && !graceOk) {
    throw new ApiError('StaleEpoch', 409, 'the envelope epoch is not accepted', { epoch: group.epoch })
  }

  if (header.senderDeviceId !== input.deviceId) throw new ApiError('NotMember', 403, 'the sender device is not the request device')
  const leaf = await repo.memberByDevice(group.groupId, input.deviceId)
  if (!leaf || leaf.userId !== input.userId || leaf.leafIndex !== header.senderLeaf) {
    throw new ApiError('NotMember', 403, 'the sender device has no such leaf in the group')
  }

  return group.groupId
}

export interface DocEnvelopeInput extends EnvelopeInputBase {
  pageId: string
  kind: 'doc_update' | 'doc_snapshot' | 'doc_title' | 'doc_banner'
}

export interface AcceptedDocEnvelope {
  groupId: Uint8Array
  epoch: number
  senderDeviceId: string
  size: number
}

/** Call inside the page route transaction. Throws ApiError (§4 Pages, §12.20). */
export async function acceptDocEnvelope(tx: Tx, input: DocEnvelopeInput): Promise<AcceptedDocEnvelope> {
  return acceptDocEnvelopeWith(drizzleMlsRepo(tx), { ds: await getDsModule(), maxEnvelopeBytes: dsConfig().maxEnvelopeBytes, now: new Date() }, input)
}

export async function acceptDocEnvelopeWith(
  repo: MlsRepo,
  deps: { ds: Pick<DsModule, 'parseDocEnvelopeHeader'>; maxEnvelopeBytes: number; now: Date },
  input: DocEnvelopeInput,
): Promise<AcceptedDocEnvelope> {
  if (input.envelope.length > deps.maxEnvelopeBytes) {
    throw new ApiError('EnvelopeTooLarge', 413, `the envelope is above ${deps.maxEnvelopeBytes} bytes`)
  }
  let header: DocEnvelopeHeader
  try {
    header = deps.ds.parseDocEnvelopeHeader(input.envelope)
  } catch {
    throw new ApiError('InvalidEnvelope', 400, 'the envelope header does not decode')
  }
  if (header.kind !== input.kind) throw new ApiError('InvalidEnvelope', 400, `the route takes a ${input.kind} envelope`)
  if (header.pageId !== input.pageId) throw new ApiError('InvalidEnvelope', 400, 'the envelope is for another page')
  const groupId = await checkGroupHeader(repo, deps.now, input, header)
  return { groupId, epoch: header.epoch, senderDeviceId: input.deviceId, size: input.envelope.length }
}
