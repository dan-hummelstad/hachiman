/**
 * Push targets (docs/gateway-protocol.md §3, §4 Push, §12.22), re-exported by schema.ts. The
 * references into schema.ts are lazy, so the import cycle between the two files is safe.
 */
import { sql } from 'drizzle-orm'
import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { devices, users } from './schema'

const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()

/** One push target per device (§4 Push): an APNs token or a Web Push endpoint. */
export const pushTargets = pgTable(
  'push_targets',
  {
    deviceId: uuid('device_id')
      .primaryKey()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['apns', 'webpush'] }).notNull(),
    /** APNs: the hex device token. Web Push: the endpoint URL. */
    token: text('token').notNull(),
    /** APNs only: the token is for the development (sandbox) environment. */
    sandbox: boolean('sandbox').notNull().default(false),
    /** Web Push only: the subscription keys for the RFC 8291 payload encryption (base64url). */
    p256dh: text('p256dh'),
    auth: text('auth'),
    /** The P-256 key that senders seal previews to (§12.22), and the device signature over it. */
    pushKey: text('push_key'),
    pushKeySig: text('push_key_sig'),
    /** The kinds that push to this device: 'dm', 'mention'. */
    kinds: text('kinds').array().notNull().default(sql`'{dm,mention}'::text[]`),
    /** Channel and guild ids that do not push (a level of 'none', a muted DM). */
    quiet: text('quiet').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (table) => [index('push_targets_user_id_idx').on(table.userId)],
)
