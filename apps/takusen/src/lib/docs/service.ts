/**
 * The pages delivery service (docs/gateway-protocol.md §4 Pages, §12.20).
 * Takusen stores the page tree, the update log and the snapshot pointers as
 * envelopes. It never decrypts. The routes run each write in one transaction
 * (access.ts docsTransaction): `drizzleDocsRepo(tx)` with `acceptDocEnvelope`
 * bound to the same `tx`. Tests run them over InMemoryDocsStore and a fake accept.
 */
import type { DocPageRow, DocUpdateRow } from '@/db/schema'
import { ApiError, NotFoundError, UploadTooLargeError, ValidationError } from '@/lib/errors'
import { bytesEqual } from '@/lib/mls/bytes'
import type { DsModule } from '@/lib/mls/crypto'
import type { AcceptedDocEnvelope, DocEnvelopeInput } from '@/lib/mls/envelopes'

import { STATE_UPDATES_MAX, type DocsLimits } from './config'
import type { DocsRepo, StoredSnapshot } from './repo'
import type { CreatePageBody, PostSnapshotBody, UpdatePageBody } from './wire'

/** `acceptDocEnvelope` bound to the route transaction. Throws ApiError (§4 Pages). */
export type AcceptDocEnvelope = (input: DocEnvelopeInput) => Promise<AcceptedDocEnvelope>

/** The caller and its X-Hachiman-Device. */
export type Actor = Pick<DocEnvelopeInput, 'userId' | 'deviceId'>

function quotaExceeded(): ApiError {
  return new ApiError('StorageQuotaExceeded', 413, 'the page storage of the guild is full')
}

/** POST /channels/:id/pages. */
export async function createPage(repo: DocsRepo, accept: AcceptDocEnvelope, input: Actor & { channelId: string; body: CreatePageBody }): Promise<DocPageRow> {
  const { body } = input
  if (body.parentId !== null) {
    const parent = await repo.getPage(body.parentId)
    if (!parent || parent.channelId !== input.channelId) throw new ValidationError('Unknown parent page')
  }
  await accept({ channelId: input.channelId, pageId: body.id, userId: input.userId, deviceId: input.deviceId, kind: 'doc_title', envelope: body.titleEnvelope })
  const row = await repo.insertPage({
    id: body.id,
    channelId: input.channelId,
    parentId: body.parentId,
    position: body.position,
    titleEnvelope: body.titleEnvelope,
    createdBy: input.userId,
  })
  if (!row) throw new ApiError('PageExists', 409, 'the page id is taken')
  return row
}

/** PATCH /pages/:pageId: a move, a reorder and/or a rename. `ifUpdatedAt` makes it a compare-and-set. */
export async function updatePage(repo: DocsRepo, accept: AcceptDocEnvelope, input: Actor & { page: DocPageRow; body: UpdatePageBody; now: Date }): Promise<DocPageRow> {
  const { page, body } = input
  if (body.parentId) {
    // Two concurrent moves could each pass the check and make a cycle together.
    await repo.lockTree(page.channelId)
    const parent = await repo.getPage(body.parentId)
    if (!parent || parent.channelId !== page.channelId) throw new ValidationError('Unknown parent page')
    if ((await repo.subtreeIds(page.id)).includes(body.parentId)) {
      throw new ApiError('PageCycle', 400, 'a page cannot move into its own subtree')
    }
  }
  if (body.ifUpdatedAt !== undefined) {
    // After lockTree: the lock order of a move. A title re-wrap must not undo a rename (§12.20).
    const locked = await repo.lockPage(page.id)
    if (!locked) throw new NotFoundError('Unknown page')
    if (locked.updatedAt.getTime() !== Date.parse(body.ifUpdatedAt)) throw new ApiError('PageConflict', 409, 'the page changed after ifUpdatedAt')
  }
  if (body.titleEnvelope) {
    await accept({ channelId: page.channelId, pageId: page.id, userId: input.userId, deviceId: input.deviceId, kind: 'doc_title', envelope: body.titleEnvelope })
  }
  const row = await repo.updatePage(page.id, {
    ...(body.parentId !== undefined && { parentId: body.parentId }),
    ...(body.position !== undefined && { position: body.position }),
    ...(body.titleEnvelope && { titleEnvelope: body.titleEnvelope }),
    updatedAt: input.now,
  })
  if (!row) throw new NotFoundError('Unknown page')
  return row
}

/** DELETE /pages/:pageId: the page and its subtree. Returns the deleted page ids and the object keys to delete after commit. */
export async function deletePage(repo: DocsRepo, page: DocPageRow): Promise<{ ids: string[]; keys: string[] }> {
  const ids = await repo.subtreeIds(page.id)
  if (ids.length === 0) throw new NotFoundError('Unknown page')
  const deleted = await repo.deletePageUploads({ pageIds: ids })
  await repo.deletePage(page.id)
  return { ids, keys: deleted.map((d) => d.key) }
}

function latestSeqOf(page: DocPageRow, updates: DocUpdateRow[]): number {
  return Math.max(page.latestSeq, updates.at(-1)?.seq ?? 0)
}

/** One page of GET /channels/:id/pages/heads. */
export interface PageHeadRow {
  page: DocPageRow
  /** The group and epoch of the title envelope header. null when the header does not decode. */
  title: { groupId: Uint8Array; epoch: number } | null
  snapshot: StoredSnapshot | null
}

/** GET /channels/:id/pages/heads: what a re-wrap pass needs, without the update log (§12.20). */
export async function listPageHeads(repo: DocsRepo, ds: Pick<DsModule, 'parseDocEnvelopeHeader'>, channelId: string): Promise<PageHeadRow[]> {
  const pages = await repo.listPages(channelId)
  const snapshots = new Map((await repo.newestSnapshots(channelId)).map((s) => [s.row.pageId, s]))
  return pages.map((page) => {
    let title: PageHeadRow['title'] = null
    try {
      const h = ds.parseDocEnvelopeHeader(page.titleEnvelope)
      title = { groupId: h.groupId, epoch: h.epoch }
    } catch {
      // A title that does not decode is not re-wrapped.
    }
    return { page, title, snapshot: snapshots.get(page.id) ?? null }
  })
}

/** GET /pages/:pageId/state. */
export async function getPageState(repo: DocsRepo, page: DocPageRow): Promise<{ snapshot: StoredSnapshot | null; updates: DocUpdateRow[]; latestSeq: number }> {
  const [snapshot] = await repo.listSnapshots(page.id)
  const updates = await repo.listUpdates(page.id, snapshot?.row.baseSeq ?? 0, STATE_UPDATES_MAX)
  return { snapshot: snapshot ?? null, updates, latestSeq: latestSeqOf(page, updates) }
}

/** GET /pages/:pageId/updates. */
export async function listUpdates(repo: DocsRepo, page: DocPageRow, query: { after: number; limit: number }): Promise<{ updates: DocUpdateRow[]; latestSeq: number }> {
  const updates = await repo.listUpdates(page.id, query.after, query.limit)
  return { updates, latestSeq: latestSeqOf(page, updates) }
}

/** POST /pages/:pageId/updates. The row lock of nextSeq makes seq gapless under concurrent senders. */
export async function postUpdate(repo: DocsRepo, accept: AcceptDocEnvelope, input: Actor & { page: DocPageRow; envelope: Uint8Array }): Promise<DocUpdateRow> {
  const { page } = input
  const accepted = await accept({ channelId: page.channelId, pageId: page.id, userId: input.userId, deviceId: input.deviceId, kind: 'doc_update', envelope: input.envelope })
  const seq = await repo.nextSeq(page.id)
  if (seq === null) throw new NotFoundError('Unknown page')
  return repo.insertUpdate({ pageId: page.id, seq, groupId: accepted.groupId, epoch: accepted.epoch, senderDevice: accepted.senderDeviceId, envelope: input.envelope })
}

/**
 * POST /pages/:pageId/snapshots: compare-and-set on base_seq, claim the blob,
 * insert, keep the previous snapshot and delete the older ones. The baseSeq of
 * the newest snapshot is a re-wrap instead. Returns the object keys to delete
 * after commit.
 */
export async function postSnapshot(
  repo: DocsRepo,
  accept: AcceptDocEnvelope,
  input: Actor & { page: DocPageRow; guildId: string; body: PostSnapshotBody; limits: DocsLimits },
): Promise<{ snapshot: StoredSnapshot; keys: string[] }> {
  const { body } = input
  const page = await repo.lockPage(input.page.id)
  if (!page) throw new NotFoundError('Unknown page')
  const existing = await repo.listSnapshots(page.id)
  const newest = existing[0]
  const current = newest?.row.baseSeq ?? 0
  const conflict = (message: string) => new ApiError('SnapshotConflict', 409, message, { baseSeq: current })
  if (newest && body.baseSeq === current) return { snapshot: await rewrap(repo, accept, input, newest, conflict), keys: [] }
  if (body.baseSeq <= current || body.baseSeq > page.latestSeq) throw conflict(`baseSeq must be above ${current} and at most ${page.latestSeq}`)
  const accepted = await accept({ channelId: page.channelId, pageId: page.id, userId: input.userId, deviceId: input.deviceId, kind: 'doc_snapshot', envelope: body.envelope })
  const blob = await repo.claimSnapshotUpload(page.id, body.uploadId, input.userId)
  if (blob.size > input.limits.maxSnapshotBytes) throw new UploadTooLargeError(`A page snapshot is at most ${input.limits.maxSnapshotBytes} bytes`)
  if (!(await repo.addPageStorage(input.guildId, blob.size, input.limits.guildStorageBytes))) throw quotaExceeded()
  const row = await repo.insertSnapshot({
    pageId: page.id,
    baseSeq: body.baseSeq,
    uploadId: body.uploadId,
    groupId: accepted.groupId,
    epoch: accepted.epoch,
    senderDevice: accepted.senderDeviceId,
    envelope: body.envelope,
    mediaUploadIds: body.mediaUploadIds,
  })

  const [previous, ...older] = existing
  if (previous) await repo.deleteUpdatesThrough(page.id, previous.row.baseSeq)
  const deleted = older.length > 0 ? await repo.deletePageUploads({ uploadIds: older.map((s) => s.row.uploadId) }) : []
  return { snapshot: { row, key: blob.key, size: blob.size }, keys: deleted.map((d) => d.key) }
}

/**
 * A re-wrap (§4 Pages, §12.20 "Access by new members"): the pointer of the newest snapshot again,
 * in a newer epoch of its group or in the new group of the channel. No claim, no quota change, no
 * delete. The stored media_upload_ids stay, so a re-wrap cannot drop a media reference.
 */
async function rewrap(
  repo: DocsRepo,
  accept: AcceptDocEnvelope,
  input: Actor & { page: DocPageRow; body: PostSnapshotBody },
  newest: StoredSnapshot,
  conflict: (message: string) => ApiError,
): Promise<StoredSnapshot> {
  const { page, body } = input
  if (body.uploadId !== newest.row.uploadId) throw conflict('a re-wrap keeps the uploadId of the newest snapshot')
  const accepted = await accept({ channelId: page.channelId, pageId: page.id, userId: input.userId, deviceId: input.deviceId, kind: 'doc_snapshot', envelope: body.envelope })
  // accept takes only the current group, so another group means that the stored one is older.
  if (bytesEqual(accepted.groupId, newest.row.groupId) && accepted.epoch <= newest.row.epoch) throw conflict('the newest snapshot is of this epoch already')
  const row = await repo.rewrapSnapshot(page.id, newest.row.baseSeq, {
    groupId: accepted.groupId,
    epoch: accepted.epoch,
    senderDevice: accepted.senderDeviceId,
    envelope: body.envelope,
  })
  if (!row) throw new NotFoundError('Unknown page')
  return { row, key: newest.key, size: newest.size }
}

/** POST /pages/:pageId/media: new claims count against the guild quota; every claim refreshes last_referenced_at. */
export async function claimMedia(
  repo: DocsRepo,
  input: { page: DocPageRow; guildId: string; userId: string; uploadIds: string[]; now: Date; limits: DocsLimits },
): Promise<void> {
  const added = await repo.claimMediaUploads(input.page.id, input.uploadIds, input.userId, input.now)
  if (added > 0 && !(await repo.addPageStorage(input.guildId, added, input.limits.guildStorageBytes))) throw quotaExceeded()
}
