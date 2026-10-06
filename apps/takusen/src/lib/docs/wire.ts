/**
 * Page rows → wire shapes (docs/gateway-protocol.md §1) and the page route
 * bodies (§4 Pages). No DB access.
 */
import { z } from 'zod'
import type { DocSnapshot, DocUpdate, Page, PageHead } from '@hachiman/client/types'

import type { DocPageRow, DocUpdateRow } from '@/db/schema'
import { toB64 } from '@/lib/mls/bytes'
import { envelopeField } from '@/lib/wire'

import { MEDIA_CLAIM_IDS_MAX, SNAPSHOT_MEDIA_IDS_MAX, UPDATES_LIMIT_DEFAULT, UPDATES_LIMIT_MAX } from './config'
import type { StoredSnapshot } from './repo'
import type { PageHeadRow } from './service'

export function toPage(row: DocPageRow): Page {
  return {
    id: row.id,
    channelId: row.channelId,
    parentId: row.parentId,
    position: row.position,
    titleEnvelope: toB64(row.titleEnvelope),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toDocUpdate(row: DocUpdateRow): DocUpdate {
  return {
    pageId: row.pageId,
    seq: row.seq,
    groupId: toB64(row.groupId),
    epoch: row.epoch,
    senderDevice: row.senderDevice,
    envelope: toB64(row.envelope),
    createdAt: row.createdAt.toISOString(),
  }
}

export function toDocSnapshot({ row, key, size }: StoredSnapshot): DocSnapshot {
  return {
    pageId: row.pageId,
    baseSeq: row.baseSeq,
    uploadId: row.uploadId,
    key,
    size,
    groupId: toB64(row.groupId),
    epoch: row.epoch,
    senderDevice: row.senderDevice,
    envelope: toB64(row.envelope),
    mediaUploadIds: row.mediaUploadIds,
    createdAt: row.createdAt.toISOString(),
  }
}

export function toPageHead({ page, title, snapshot }: PageHeadRow): PageHead {
  return {
    pageId: page.id,
    latestSeq: page.latestSeq,
    title: title && { groupId: toB64(title.groupId), epoch: title.epoch },
    snapshot: snapshot && toDocSnapshot(snapshot),
  }
}

const position = z.number().int().min(0).max(2 ** 31 - 1)
const uniqueIds = (max: number, min = 0) =>
  z
    .array(z.string().uuid())
    .min(min)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate upload id')

export const createPageSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  position: position.default(0),
  titleEnvelope: envelopeField,
})
export type CreatePageBody = z.infer<typeof createPageSchema>

export const updatePageSchema = z
  .object({
    parentId: z.string().uuid().nullable().optional(),
    position: position.optional(),
    titleEnvelope: envelopeField.optional(),
    /** Compare-and-set: 409 PageConflict when the page `updatedAt` differs. */
    ifUpdatedAt: z.string().datetime().optional(),
  })
  .strict()
export type UpdatePageBody = z.infer<typeof updatePageSchema>

export const postUpdateSchema = z.object({ envelope: envelopeField })

export const postSnapshotSchema = z.object({
  baseSeq: z.number().int().min(1),
  uploadId: z.string().uuid(),
  envelope: envelopeField,
  mediaUploadIds: uniqueIds(SNAPSHOT_MEDIA_IDS_MAX).default([]),
})
export type PostSnapshotBody = z.infer<typeof postSnapshotSchema>

export const claimMediaSchema = z.object({ uploadIds: uniqueIds(MEDIA_CLAIM_IDS_MAX, 1) })

const updatesQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(UPDATES_LIMIT_MAX).default(UPDATES_LIMIT_DEFAULT),
})

export function parseUpdatesQuery(params: URLSearchParams): { after: number; limit: number } {
  return updatesQuery.parse({ after: params.get('after') ?? undefined, limit: params.get('limit') ?? undefined })
}
