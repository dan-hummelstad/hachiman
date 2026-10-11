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
import type { DocPagePatch, DocsRepo, StoredSnapshot } from './repo'
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

export type UpdatePageInput = Actor & { page: DocPageRow; guildId: string; body: UpdatePageBody; now: Date; limits: DocsLimits }

/**
 * PATCH /pages/:pageId: a move, a reorder, a rename and/or a banner change. `ifUpdatedAt` makes it
 * a compare-and-set.
 */
export async function updatePage(repo: DocsRepo, accept: AcceptDocEnvelope, input: UpdatePageInput): Promise<DocPageRow> {
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
  // After lockTree: the lock order of a move. The compare and the banner rules read the locked
  // row, not the unlocked `page` of the route.
  let current = page
  if (body.ifUpdatedAt !== undefined || body.banner !== undefined || body.parentId) {
    const locked = await repo.lockPage(page.id)
    if (!locked) throw new NotFoundError('Unknown page')
    current = locked
  }
  if (body.ifUpdatedAt !== undefined && current.updatedAt.getTime() !== Date.parse(body.ifUpdatedAt)) {
    // A re-wrap must not undo a rename or a banner change (§12.20).
    throw new ApiError('PageConflict', 409, 'the page changed after ifUpdatedAt')
  }
  if (body.titleEnvelope) {
    await accept({ channelId: page.channelId, pageId: page.id, userId: input.userId, deviceId: input.deviceId, kind: 'doc_title', envelope: body.titleEnvelope })
  }
  const banner = await bannerPatch(repo, accept, { ...input, page: current })
  const row = await repo.updatePage(page.id, {
    ...(body.parentId !== undefined && { parentId: body.parentId }),
    ...(body.position !== undefined && { position: body.position }),
    ...(body.titleEnvelope && { titleEnvelope: body.titleEnvelope }),
    ...banner,
    updatedAt: input.now,
  })
  if (!row) throw new NotFoundError('Unknown page')
  return row
}

/**
 * The banner columns of a PATCH (§4 Pages "Banner"). `page` is the locked row. Only a top-level
 * page has a banner. Dropped ids get last_referenced_at = now, so the media sweep keeps them for
 * its undo window.
 */
async function bannerPatch(repo: DocsRepo, accept: AcceptDocEnvelope, input: UpdatePageInput): Promise<Pick<DocPagePatch, 'bannerEnvelope' | 'bannerUploadIds'>> {
  const { page, body, now } = input
  const parentId = body.parentId !== undefined ? body.parentId : page.parentId
  // A move under a page clears the banner as `banner: null` does.
  const banner = body.banner === undefined && parentId !== null && page.bannerEnvelope !== null ? null : body.banner
  if (banner === undefined) return {}
  const stored = page.bannerUploadIds
  if (banner === null) {
    await repo.touchPageMedia(page.id, stored, now)
    return { bannerEnvelope: null, bannerUploadIds: [] }
  }
  if (parentId !== null) throw new ValidationError('Only a top-level page has a banner')
  await accept({ channelId: page.channelId, pageId: page.id, userId: input.userId, deviceId: input.deviceId, kind: 'doc_banner', envelope: banner.envelope })
  const ids = banner.uploadIds
  if (ids === undefined) {
    // A re-wrap: the caller need not be the uploader, and cannot drop a media reference.
    if (page.bannerEnvelope === null) throw new ValidationError('The page has no banner to re-wrap')
    return { bannerEnvelope: banner.envelope }
  }
  const fresh = ids.filter((id) => !stored.includes(id))
  if (fresh.length > 0) {
    const added = await repo.claimMediaUploads(page.id, fresh, input.userId, now)
    if (added > 0 && !(await repo.addPageStorage(input.guildId, added, input.limits.guildStorageBytes))) throw quotaExceeded()
  }
  await repo.touchPageMedia(page.id, stored.filter((id) => !ids.includes(id)), now)
  return { bannerEnvelope: banner.envelope, bannerUploadIds: ids }
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

export interface EnvelopeHead {
  groupId: Uint8Array
  epoch: number
}

/** One page of GET /channels/:id/pages/heads. */
export interface PageHeadRow {
  page: DocPageRow
  /** The group and epoch of the title envelope header. null when the header does not decode. */
  title: EnvelopeHead | null
  /** The same for the banner envelope. null also when the page has no banner. */
  banner: EnvelopeHead | null
  snapshot: StoredSnapshot | null
}

/** GET /channels/:id/pages/heads: what a re-wrap pass needs, without the update log (§12.20). */
export async function listPageHeads(repo: DocsRepo, ds: Pick<DsModule, 'parseDocEnvelopeHeader'>, channelId: string): Promise<PageHeadRow[]> {
  const pages = await repo.listPages(channelId)
  const snapshots = new Map((await repo.newestSnapshots(channelId)).map((s) => [s.row.pageId, s]))
  const head = (envelope: Uint8Array | null): EnvelopeHead | null => {
    if (envelope === null) return null
    try {
      const h = ds.parseDocEnvelopeHeader(envelope)
      return { groupId: h.groupId, epoch: h.epoch }
    } catch {
      // An envelope that does not decode is not re-wrapped.
      return null
    }
  }
  return pages.map((page) => ({ page, title: head(page.titleEnvelope), banner: head(page.bannerEnvelope), snapshot: snapshots.get(page.id) ?? null }))
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
