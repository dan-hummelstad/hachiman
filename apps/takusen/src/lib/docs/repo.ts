/**
 * The storage seam of the pages delivery service (docs/gateway-protocol.md §4
 * Pages). One repo is bound to one transaction: the routes use
 * `drizzleDocsRepo(tx)`, and the tests use `InMemoryDocsStore.transaction`.
 * Change both implementations together, and run repo.conformance.ts.
 */
import type { DocPageRow, DocSnapshotRow, DocUpdateRow } from '@/db/schema'

export type NewDocPage = Pick<DocPageRow, 'id' | 'channelId' | 'parentId' | 'position' | 'titleEnvelope' | 'createdBy'>
export type DocPagePatch = Partial<Pick<DocPageRow, 'parentId' | 'position' | 'titleEnvelope'>> & { updatedAt: Date }
export type NewDocUpdate = Omit<DocUpdateRow, 'createdAt'>
export type NewDocSnapshot = Omit<DocSnapshotRow, 'createdAt'>
/** The columns that a re-wrap replaces (§4 Pages): the pointer envelope and its header fields. */
export type SnapshotRewrap = Pick<DocSnapshotRow, 'groupId' | 'epoch' | 'senderDevice' | 'envelope'>

/** A snapshot row with the key and the size of its blob. */
export interface StoredSnapshot {
  row: DocSnapshotRow
  key: string
  size: number
}

export interface DeletedUpload {
  key: string
  size: number
}

export interface DocsRepo {
  listPages(channelId: string): Promise<DocPageRow[]>
  getPage(pageId: string): Promise<DocPageRow | null>
  /** The page row, locked until the end of the transaction. */
  lockPage(pageId: string): Promise<DocPageRow | null>
  /** Serializes the tree moves of one channel until the end of the transaction. */
  lockTree(channelId: string): Promise<void>
  /** null when the id is taken. */
  insertPage(values: NewDocPage): Promise<DocPageRow | null>
  updatePage(pageId: string, patch: DocPagePatch): Promise<DocPageRow | null>
  /** The page and every page under it. Empty when the page does not exist. */
  subtreeIds(pageId: string): Promise<string[]>
  /** Deletes the page. Its subtree, updates and snapshots go with it. */
  deletePage(pageId: string): Promise<void>

  /** Sets latest_seq = latest_seq + 1 under the row lock and returns it. null when the page does not exist. */
  nextSeq(pageId: string): Promise<number | null>
  insertUpdate(values: NewDocUpdate): Promise<DocUpdateRow>
  /** seq > after, ascending. */
  listUpdates(pageId: string, after: number, limit: number): Promise<DocUpdateRow[]>
  deleteUpdatesThrough(pageId: string, seq: number): Promise<void>

  /** Newest (highest base_seq) first. */
  listSnapshots(pageId: string): Promise<StoredSnapshot[]>
  /** The newest snapshot of each page of the channel. A page without a snapshot has none. */
  newestSnapshots(channelId: string): Promise<StoredSnapshot[]>
  insertSnapshot(values: NewDocSnapshot): Promise<DocSnapshotRow>
  /**
   * A re-wrap: replaces the envelope columns of snapshot (pageId, baseSeq) in place. Keeps
   * upload_id, media_upload_ids and created_at. null when the row does not exist.
   */
  rewrapSnapshot(pageId: string, baseSeq: number, values: SnapshotRewrap): Promise<DocSnapshotRow | null>

  /** lib/uploads.ts pageSnapshotClaimable. Throws UnknownUpload. */
  claimSnapshotUpload(pageId: string, uploadId: string, userId: string): Promise<{ key: string; size: number }>
  /** lib/uploads.ts pageMediaClaimable, for every id. Returns the bytes of the new claims. Throws UnknownUpload. */
  claimMediaUploads(pageId: string, uploadIds: string[], userId: string, now: Date): Promise<number>
  /** Deletes claimed page uploads (snapshot rows cascade), subtracts their bytes from the guild quota. */
  deletePageUploads(scope: { pageIds: string[] } | { uploadIds: string[] }): Promise<DeletedUpload[]>
  /**
   * Adds `bytes` to guilds.page_storage_bytes under the guild row lock. False
   * (and no change) when the sum would pass `limit` (0 = no limit).
   */
  addPageStorage(guildId: string, bytes: number, limit: number): Promise<boolean>
}
