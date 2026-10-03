/**
 * The pages channel tables (docs/gateway-protocol.md §3 "Pages tables"),
 * re-exported by schema.ts. The references into schema.ts are lazy, so the
 * import cycle between the two files is safe.
 */
import { sql } from 'drizzle-orm'
import { bigint, index, integer, pgTable, primaryKey, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'

import { bytea } from './columns'
import { channels, devices, mlsGroups, uploads, users } from './schema'

// ---------------------------------------------------------------------------
// Pages channels (contract §3 "Pages tables", §4 Pages, §12.20). The server sees
// the tree and the timestamps. Titles, updates and snapshot pointers are envelopes.
// ---------------------------------------------------------------------------
export const docPages = pgTable(
  'doc_pages',
  {
    // The client chooses the id: the title envelope binds it (§12.20).
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => docPages.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    titleEnvelope: bytea('title_envelope').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    // The highest doc_updates.seq of the page. An update takes latest_seq + 1 (§4 Pages).
    latestSeq: bigint('latest_seq', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('doc_pages_channel_id_idx').on(table.channelId),
    index('doc_pages_parent_id_idx').on(table.parentId),
  ],
)

export const docUpdates = pgTable(
  'doc_updates',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => docPages.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    groupId: bytea('group_id')
      .notNull()
      .references((): AnyPgColumn => mlsGroups.groupId, { onDelete: 'cascade' }),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    senderDevice: uuid('sender_device').references((): AnyPgColumn => devices.id, { onDelete: 'set null' }),
    envelope: bytea('envelope').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.pageId, table.seq] })],
)

export const docSnapshots = pgTable(
  'doc_snapshots',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => docPages.id, { onDelete: 'cascade' }),
    // The state covers every update with seq <= base_seq.
    baseSeq: bigint('base_seq', { mode: 'number' }).notNull(),
    uploadId: uuid('upload_id')
      .notNull()
      .unique()
      .references(() => uploads.id, { onDelete: 'cascade' }),
    groupId: bytea('group_id')
      .notNull()
      .references((): AnyPgColumn => mlsGroups.groupId, { onDelete: 'cascade' }),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    senderDevice: uuid('sender_device').references((): AnyPgColumn => devices.id, { onDelete: 'set null' }),
    // The doc_snapshot envelope: the pointer and the file key of the blob.
    envelope: bytea('envelope').notNull(),
    // The page_media uploads that this state references. The client gives the list.
    mediaUploadIds: uuid('media_upload_ids').array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.pageId, table.baseSeq] })],
)

export type DocPageRow = typeof docPages.$inferSelect
export type DocUpdateRow = typeof docUpdates.$inferSelect
export type DocSnapshotRow = typeof docSnapshots.$inferSelect
