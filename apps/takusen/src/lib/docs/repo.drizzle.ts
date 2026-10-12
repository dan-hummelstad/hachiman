/**
 * DocsRepo on Postgres (repo.ts). The locks need a transaction: pass the `tx`
 * of the route. The read routes pass `db`.
 */
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm'

import { db, type Database, type Tx } from '@/db/client'
import { channels, docPages, docSnapshots, docUpdates, guilds, uploads } from '@/db/schema'
import { claimPageMedia, claimPageSnapshot, deletePageUploadRows, deleteUploadsOfPages } from '@/lib/uploads'

import type { DocsRepo } from './repo'

export function drizzleDocsRepo(x: Database | Tx = db): DocsRepo {
  return {
    async listPages(channelId) {
      return x.select().from(docPages).where(eq(docPages.channelId, channelId))
    },
    async getPage(pageId) {
      const [row] = await x.select().from(docPages).where(eq(docPages.id, pageId)).limit(1)
      return row ?? null
    },
    async lockPage(pageId) {
      const [row] = await x.select().from(docPages).where(eq(docPages.id, pageId)).for('update')
      return row ?? null
    },
    async lockTree(channelId) {
      // NO KEY UPDATE: message inserts key-share-lock the channel row and must not wait.
      await x.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).for('no key update')
    },
    async insertPage(values) {
      const [row] = await x.insert(docPages).values(values).onConflictDoNothing({ target: docPages.id }).returning()
      return row ?? null
    },
    async updatePage(pageId, patch) {
      const [row] = await x.update(docPages).set(patch).where(eq(docPages.id, pageId)).returning()
      return row ?? null
    },
    async subtreeIds(pageId) {
      const rows = await x.execute<{ id: string }>(sql`
        with recursive t(id) as (
          select id from ${docPages} where id = ${pageId}
          union
          select p.id from ${docPages} p join t on p.parent_id = t.id
        ) select id from t`)
      return rows.map((r) => r.id)
    },
    async deletePage(pageId) {
      await x.delete(docPages).where(eq(docPages.id, pageId))
    },

    async nextSeq(pageId) {
      const [row] = await x
        .update(docPages)
        .set({ latestSeq: sql`${docPages.latestSeq} + 1` })
        .where(eq(docPages.id, pageId))
        .returning({ seq: docPages.latestSeq })
      return row?.seq ?? null
    },
    async insertUpdate(values) {
      const [row] = await x.insert(docUpdates).values(values).returning()
      return row!
    },
    async listUpdates(pageId, after, limit) {
      return x
        .select()
        .from(docUpdates)
        .where(and(eq(docUpdates.pageId, pageId), gt(docUpdates.seq, after)))
        .orderBy(asc(docUpdates.seq))
        .limit(limit)
    },
    async deleteUpdatesThrough(pageId, seq) {
      await x.delete(docUpdates).where(and(eq(docUpdates.pageId, pageId), lte(docUpdates.seq, seq)))
    },

    async listSnapshots(pageId) {
      return x
        .select({ row: docSnapshots, key: uploads.key, size: uploads.size })
        .from(docSnapshots)
        .innerJoin(uploads, eq(uploads.id, docSnapshots.uploadId))
        .where(eq(docSnapshots.pageId, pageId))
        .orderBy(desc(docSnapshots.baseSeq))
    },
    async newestSnapshots(channelId) {
      return x
        .selectDistinctOn([docSnapshots.pageId], { row: docSnapshots, key: uploads.key, size: uploads.size })
        .from(docSnapshots)
        .innerJoin(uploads, eq(uploads.id, docSnapshots.uploadId))
        .innerJoin(docPages, eq(docPages.id, docSnapshots.pageId))
        .where(eq(docPages.channelId, channelId))
        .orderBy(docSnapshots.pageId, desc(docSnapshots.baseSeq))
    },
    async insertSnapshot(values) {
      const [row] = await x.insert(docSnapshots).values(values).returning()
      return row!
    },
    async rewrapSnapshot(pageId, baseSeq, values) {
      const [row] = await x
        .update(docSnapshots)
        .set(values)
        .where(and(eq(docSnapshots.pageId, pageId), eq(docSnapshots.baseSeq, baseSeq)))
        .returning()
      return row ?? null
    },

    claimSnapshotUpload: (pageId, uploadId, userId) => claimPageSnapshot(x, pageId, uploadId, userId),
    claimMediaUploads: (pageId, uploadIds, userId, now) => claimPageMedia(x, pageId, uploadIds, userId, now),
    async touchPageMedia(pageId, uploadIds, now) {
      if (uploadIds.length === 0) return
      await x
        .update(uploads)
        .set({ lastReferencedAt: now })
        .where(and(inArray(uploads.id, uploadIds), eq(uploads.purpose, 'page_media'), eq(uploads.pageId, pageId)))
    },
    deletePageUploads: (scope) =>
      'pageIds' in scope ? deleteUploadsOfPages(x, inArray(docPages.id, scope.pageIds)) : deletePageUploadRows(x, inArray(uploads.id, scope.uploadIds)),
    async addPageStorage(guildId, bytes, limit) {
      const fits = bytes > 0 && limit > 0 ? sql`${guilds.pageStorageBytes} + ${bytes} <= ${limit}` : undefined
      const [row] = await x
        .update(guilds)
        .set({ pageStorageBytes: sql`greatest(0, ${guilds.pageStorageBytes} + ${bytes})` })
        .where(and(eq(guilds.id, guildId), fits))
        .returning({ id: guilds.id })
      return row !== undefined
    },
  }
}
