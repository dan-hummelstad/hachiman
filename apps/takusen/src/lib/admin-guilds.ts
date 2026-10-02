/**
 * Guild listing for the deployment admin API (contract §4 Admin API).
 */
import { and, desc, eq, ilike, sql, type SQL } from 'drizzle-orm'

import { db } from '@/db/client'
import { guildMembers, guilds, users } from '@/db/schema'
import {
  afterCursor,
  cursorColumn,
  likePattern,
  toPage,
  type AdminGuild,
  type ListQuery,
  type Page,
} from '@/lib/admin'

/** Newest first. `query` matches the guild name. */
export async function listGuilds(q: ListQuery): Promise<Page<AdminGuild>> {
  const where: SQL[] = []
  if (q.query) where.push(ilike(guilds.name, likePattern(q.query)))
  if (q.cursor) where.push(afterCursor(guilds.createdAt, guilds.id, q.cursor))
  const rows = await db
    .select({
      id: guilds.id,
      name: guilds.name,
      icon: guilds.icon,
      region: guilds.region,
      createdAt: guilds.createdAt,
      cursor: cursorColumn(guilds.createdAt),
      owner: { id: users.id, email: users.email, displayName: users.displayName },
      memberCount: sql<number>`(SELECT count(*)::int FROM ${guildMembers} WHERE ${guildMembers.guildId} = ${guilds.id})`,
    })
    .from(guilds)
    .innerJoin(users, eq(users.id, guilds.ownerId))
    .where(and(...where))
    .orderBy(desc(guilds.createdAt), desc(guilds.id))
    .limit(q.limit + 1)
  return toPage(rows, q.limit, (g): AdminGuild => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    region: g.region,
    owner: g.owner,
    memberCount: g.memberCount,
    createdAt: g.createdAt.toISOString(),
  }))
}
