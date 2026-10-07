/**
 * Pins, guild events and user blocks (docs/gateway-protocol.md §3, §4 "Pins,
 * guild events and blocks"), re-exported by schema.ts. The references into schema.ts are
 * lazy, so the import cycle between the two files is safe.
 */
import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { channels, guilds, messages, users } from './schema'

const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()

// The server learns which message ids are pinned. It learns no content.
export const channelPins = pgTable(
  'channel_pins',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    pinnedBy: uuid('pinned_by').references(() => users.id, { onDelete: 'set null' }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.messageId] })],
)

// Plaintext metadata, like a channel topic (§12.1).
export const guildEvents = pgTable(
  'guild_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [index('guild_events_guild_starts_idx').on(table.guildId, table.startsAt)],
)

export const guildEventRsvps = pgTable(
  'guild_event_rsvps',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => guildEvents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.userId] })],
)

export const userBlocks = pgTable(
  'user_blocks',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedUserId: uuid('blocked_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.blockedUserId] }),
    index('user_blocks_blocked_user_id_idx').on(table.blockedUserId),
  ],
)

export type GuildEventRow = typeof guildEvents.$inferSelect
