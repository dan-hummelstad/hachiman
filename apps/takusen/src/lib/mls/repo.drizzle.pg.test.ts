/**
 * The MlsRepo conformance suite on drizzleMlsRepo and a real Postgres.
 *
 * It runs only when TAKUSEN_PG_TEST_URL is set, so `pnpm test` stays free of
 * a database. The database must have the Takusen migrations (README.md has
 * the commands). The suite refuses the database named `takusen`: that is the
 * dev database, and the suite writes rows to it that it does not delete.
 */
import { randomUUID } from 'node:crypto'

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from '@/db/schema'

import { describeMlsRepo } from './repo.conformance'
import { drizzleMlsRepo } from './repo.drizzle'

const url = process.env.TAKUSEN_PG_TEST_URL

function databaseName(u: string): string {
  return decodeURIComponent(new URL(u).pathname.replace(/^\//, ''))
}

const skip = !url ? 'TAKUSEN_PG_TEST_URL is not set' : databaseName(url) === 'takusen' ? 'TAKUSEN_PG_TEST_URL names the dev database "takusen"' : false

describeMlsRepo(
  'drizzleMlsRepo (Postgres)',
  async () => {
    const client = postgres(url!, { max: 4, onnotice: () => {} })
    const db = drizzle(client, { schema })
    const repo = drizzleMlsRepo(db)
    return {
      repo,
      fx: {
        async addUser() {
          const id = randomUUID()
          await db.insert(schema.users).values({ id, email: `${id}@conformance.test`, displayName: 'conformance' })
          return id
        },
        async addGuild(ownerId, everyonePermissions = 0) {
          const id = randomUUID()
          await db.insert(schema.guilds).values({ id, ownerId, name: 'conformance' })
          await db.insert(schema.roles).values({ id, guildId: id, name: '@everyone', permissions: everyonePermissions })
          await db.insert(schema.guildMembers).values({ guildId: id, userId: ownerId })
          return id
        },
        async addRole(guildId, permissions) {
          const id = randomUUID()
          await db.insert(schema.roles).values({ id, guildId, name: 'role', permissions })
          return id
        },
        async addGuildMember(guildId, userId, roleIds = []) {
          await db.insert(schema.guildMembers).values({ guildId, userId })
          for (const roleId of roleIds) await db.insert(schema.memberRoles).values({ guildId, userId, roleId })
        },
        async addChannel(c) {
          const id = randomUUID()
          await db.insert(schema.channels).values({ id, guildId: c.guildId, type: c.type, name: 'conformance' })
          return id
        },
        async setOverwrites(channelId, ows) {
          for (const o of ows) {
            await db.insert(schema.permissionOverwrites).values({ channelId, targetId: o.id, targetType: o.type, allow: o.allow, deny: o.deny })
          }
        },
        async addDm(participants) {
          const id = randomUUID()
          await db.insert(schema.channels).values({ id, guildId: null, type: 'dm' })
          for (const userId of participants) await db.insert(schema.dmParticipants).values({ channelId: id, userId })
          return id
        },
        async addInvite(i) {
          const id = randomUUID()
          await db.insert(schema.invites).values({ id, code: randomUUID(), guildId: i.guildId, createdBy: i.createdBy, keyId: i.keyId, record: i.record, expiresAt: i.expiresAt, revoked: i.revoked })
          return id
        },
        async addInviteMember(guildId, userId, inviteId, joinedAt) {
          await db.insert(schema.guildMembers).values({ guildId, userId, inviteId, joinedAt })
        },
      },
      async close() {
        await client.end()
      },
    }
  },
  { skip },
)
