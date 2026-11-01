/**
 * Bot accounts (docs/gateway-protocol.md §3, §4 Bots), re-exported by schema.ts. The
 * references into schema.ts are lazy, so the import cycle between the two files is safe.
 */
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { users } from './schema'

const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()

/** A bot user (`users.bot = true`) and the human user that owns it. */
export const bots = pgTable(
  'bots',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [index('bots_owner_idx').on(t.ownerId)],
)

/** A bot API token. Takusen keeps only the hex SHA-256 of the token. One live token per bot. */
export const botTokens = pgTable(
  'bot_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.userId, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [index('bot_tokens_bot_idx').on(t.botId)],
)
