/**
 * The InviteHistoryStore conformance suite on drizzleInviteHistoryStore and a
 * real Postgres (§12.11.4).
 *
 * It runs only when TAKUSEN_PG_TEST_URL is set, as repo.drizzle.pg.test.ts
 * does, and it refuses the dev database `takusen`. The database must have the
 * Takusen migrations. The suite does not delete its rows.
 */
import { randomUUID } from 'node:crypto'

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from '@/db/schema'
import { generateInviteCode } from '@/lib/invites'

import { drizzleInviteHistoryStore } from './invite-history'
import { describeInviteHistoryStore, historySeed } from './invite-history.conformance'

const url = process.env.TAKUSEN_PG_TEST_URL

function databaseName(u: string): string {
  return decodeURIComponent(new URL(u).pathname.replace(/^\//, ''))
}

const skip = !url ? 'TAKUSEN_PG_TEST_URL is not set' : databaseName(url) === 'takusen' ? 'TAKUSEN_PG_TEST_URL names the dev database "takusen"' : false

describeInviteHistoryStore(
  'drizzleInviteHistoryStore (Postgres)',
  async () => {
    const client = postgres(url!, { max: 4, onnotice: () => {} })
    const db = drizzle(client, { schema })
    return {
      store: drizzleInviteHistoryStore(db),
      fx: {
        async addUser() {
          const id = randomUUID()
          await db.insert(schema.users).values({ id, email: `${id}@invite-history.test`, displayName: 'invite-history' })
          return id
        },
        async addGuild(ownerId) {
          const id = randomUUID()
          await db.insert(schema.guilds).values({ id, ownerId, name: 'invite-history' })
          await db.insert(schema.roles).values({ id, guildId: id, name: '@everyone', permissions: 0 })
          await db.insert(schema.guildMembers).values({ guildId: id, userId: ownerId })
          return id
        },
        async addInvite({ history, ...seed }) {
          const [row] = await db
            .insert(schema.invites)
            .values({ ...seed, code: generateInviteCode(), ...(history && historySeed()) })
            .returning()
          return row!
        },
      },
      close: async () => {
        await client.end()
      },
    }
  },
  { skip },
)
