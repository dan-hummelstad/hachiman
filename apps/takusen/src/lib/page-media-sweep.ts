/**
 * The page media sweep (docs/gateway-protocol.md §4 Pages). The server cannot
 * read a page, so each snapshot lists the page_media uploads its state uses
 * (`doc_snapshots.media_upload_ids`). The daily DS sweep of the gRPC process
 * (grpc/mls-scheduler.ts) deletes a page_media upload when:
 *
 * - neither the current nor the previous snapshot of its page lists it,
 * - it is older than PAGE_MEDIA_RETENTION_MS (the undo and restore window),
 * - and its last claim (`last_referenced_at`) is older than that too: a client
 *   claims again when it adds the media, so an update after the current
 *   snapshot keeps it.
 */
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'

import { db } from '@/db/client'
import { docSnapshots, uploads } from '@/db/schema'
import { releasePageStorage } from '@/lib/uploads'

export const PAGE_MEDIA_RETENTION_MS = 30 * 24 * 60 * 60_000

const SWEEP_BATCH = 1000

export interface PageMediaUpload {
  id: string
  createdAt: Date
  lastReferencedAt: Date | null
}

/** The rule of the sweep. `snapshotMedia`: media_upload_ids of the two newest snapshots of the page. */
export function isUnreferencedPageMedia(u: PageMediaUpload, snapshotMedia: readonly (readonly string[])[], before: Date): boolean {
  if (u.createdAt >= before) return false
  if (u.lastReferencedAt && u.lastReferencedAt >= before) return false
  return !snapshotMedia.some((ids) => ids.includes(u.id))
}

export interface PageMediaSweepRepo {
  /** Deletes the page_media rows that isUnreferencedPageMedia selects and returns their object keys. */
  deleteUnreferencedPageMedia(before: Date): Promise<string[]>
}

export function drizzlePageMediaSweepRepo(): PageMediaSweepRepo {
  return {
    async deleteUnreferencedPageMedia(before) {
      const keys: string[] = []
      for (;;) {
        const batch = await db.transaction(async (tx) => {
          const stale = await tx
            .select({ id: uploads.id })
            .from(uploads)
            .where(
              and(
                eq(uploads.purpose, 'page_media'),
                lt(uploads.createdAt, before),
                or(isNull(uploads.lastReferencedAt), lt(uploads.lastReferencedAt, before)),
                sql`not exists (select 1 from (select ${docSnapshots.mediaUploadIds} as ids from ${docSnapshots} where ${docSnapshots.pageId} = ${uploads.pageId} order by ${docSnapshots.baseSeq} desc limit 2) latest where ${uploads.id} = any(latest.ids))`,
              ),
            )
            .limit(SWEEP_BATCH)
            .for('update', { skipLocked: true })
          if (stale.length === 0) return []
          const ids = inArray(uploads.id, stale.map((s) => s.id))
          await releasePageStorage(tx, ids)
          const rows = await tx.delete(uploads).where(ids).returning({ key: uploads.key })
          return rows.map((r) => r.key)
        })
        keys.push(...batch)
        if (batch.length < SWEEP_BATCH) return keys
      }
    },
  }
}

/** In-memory PageMediaSweepRepo for tests: the same rule over plain rows. */
export class InMemoryPageMediaSweepRepo implements PageMediaSweepRepo {
  readonly uploads = new Map<string, PageMediaUpload & { pageId: string; key: string }>()
  /** pageId → snapshots, oldest first. */
  readonly snapshots = new Map<string, string[][]>()

  async deleteUnreferencedPageMedia(before: Date): Promise<string[]> {
    const keys: string[] = []
    for (const [id, u] of this.uploads) {
      if (!isUnreferencedPageMedia(u, (this.snapshots.get(u.pageId) ?? []).slice(-2), before)) continue
      this.uploads.delete(id)
      keys.push(u.key)
    }
    return keys
  }
}

/** One sweep pass: deletes the rows, then (best effort) their objects. Returns the number of uploads. */
export async function sweepPageMedia(repo: PageMediaSweepRepo, now: Date, deleteObjects: (keys: string[]) => Promise<void>): Promise<number> {
  const keys = await repo.deleteUnreferencedPageMedia(new Date(now.getTime() - PAGE_MEDIA_RETENTION_MS))
  if (keys.length > 0) await deleteObjects(keys)
  return keys.length
}
