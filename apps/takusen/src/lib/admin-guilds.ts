/**
 * Guild listing, guild detail and invite revoke for the deployment admin API
 * (contract §4 Admin API).
 */
import { and, count, desc, eq, gt, ilike, isNull, lt, or, sql, type SQL } from 'drizzle-orm'

import { db } from '@/db/client'
import { channels, docPages, guildMembers, guilds, invites, users } from '@/db/schema'
import {
  afterCursor,
  cursorColumn,
  likePattern,
  toPage,
  type AdminGuild,
  type AdminGuildDetail,
  type AdminInvite,
  type ListQuery,
  type Page,
} from '@/lib/admin'
import { NotFoundError } from '@/lib/errors'
import { readPresences } from '@/lib/guilds'
import { drizzleInviteHistoryStore } from '@/lib/invite-history'
import { publishInviteDeletes } from '@/lib/invite-limits'

const guildColumns = {
  id: guilds.id,
  name: guilds.name,
  icon: guilds.icon,
  banner: guilds.banner,
  region: guilds.region,
  createdAt: guilds.createdAt,
  cursor: cursorColumn(guilds.createdAt),
  owner: { id: users.id, email: users.email, displayName: users.displayName, avatar: users.image },
  memberCount: sql<number>`(SELECT count(*)::int FROM ${guildMembers} WHERE ${guildMembers.guildId} = ${guilds.id})`,
  channelCount: sql<number>`(SELECT count(*)::int FROM ${channels} WHERE ${channels.guildId} = ${guilds.id} AND ${channels.type} NOT IN ('category', 'thread'))`,
}

type GuildRow = {
  id: string
  name: string
  icon: string | null
  region: string | null
  createdAt: Date
  owner: AdminGuild['owner']
  memberCount: number
  channelCount: number
}

function toAdminGuild(g: GuildRow): AdminGuild {
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    region: g.region,
    owner: g.owner,
    memberCount: g.memberCount,
    channelCount: g.channelCount,
    createdAt: g.createdAt.toISOString(),
  }
}

/** Newest first. `query` matches the guild name. `channelCount` leaves out categories and threads. */
export async function listGuilds(q: ListQuery): Promise<Page<AdminGuild>> {
  const where: SQL[] = []
  if (q.query) where.push(ilike(guilds.name, likePattern(q.query)))
  if (q.cursor) where.push(afterCursor(guilds.createdAt, guilds.id, q.cursor))
  const rows = await db
    .select(guildColumns)
    .from(guilds)
    .innerJoin(users, eq(users.id, guilds.ownerId))
    .where(and(...where))
    .orderBy(desc(guilds.createdAt), desc(guilds.id))
    .limit(q.limit + 1)
  return toPage(rows, q.limit, toAdminGuild)
}

/** The invites that `inviteUsability` (invite-history.ts) calls `ok`, as SQL. */
function usableInvite(now: Date): SQL {
  return and(
    eq(invites.revoked, false),
    or(isNull(invites.expiresAt), gt(invites.expiresAt, now)),
    isNull(invites.exhaustedAt),
    or(isNull(invites.maxUses), lt(invites.uses, invites.maxUses)),
  ) as SQL
}

export async function getGuildDetail(id: string): Promise<AdminGuildDetail> {
  const [row] = await db.select(guildColumns).from(guilds).innerJoin(users, eq(users.id, guilds.ownerId)).where(eq(guilds.id, id)).limit(1)
  if (!row) throw new NotFoundError('Unknown guild')
  const [members, [pages], inviteRows] = await Promise.all([
    db.select({ userId: guildMembers.userId }).from(guildMembers).where(eq(guildMembers.guildId, id)),
    db
      .select({ n: count() })
      .from(docPages)
      .innerJoin(channels, eq(channels.id, docPages.channelId))
      .where(eq(channels.guildId, id)),
    db
      .select({
        code: invites.code,
        uses: invites.uses,
        maxUses: invites.maxUses,
        expiresAt: invites.expiresAt,
        record: sql<boolean>`${invites.record} IS NOT NULL`,
        createdAt: invites.createdAt,
        createdBy: { id: users.id, displayName: users.displayName },
      })
      .from(invites)
      .innerJoin(users, eq(users.id, invites.createdBy))
      .where(and(eq(invites.guildId, id), usableInvite(new Date())))
      .orderBy(desc(invites.createdAt)),
  ])
  const online = await readPresences(members.map((m) => m.userId))
  return {
    ...toAdminGuild(row),
    banner: row.banner,
    onlineCount: online.length,
    pageCount: pages?.n ?? 0,
    invites: inviteRows.map(
      (i): AdminInvite => ({
        code: i.code,
        uses: i.uses,
        maxUses: i.maxUses,
        expiresAt: i.expiresAt ? i.expiresAt.toISOString() : null,
        hasHistory: i.record,
        createdBy: i.createdBy,
        createdAt: i.createdAt.toISOString(),
      }),
    ),
  }
}

/** The same revoke as `DELETE /api/v1/invites/:code`, without the guild permission check. */
export async function revokeGuildInvite(guildId: string, code: string): Promise<void> {
  const [invite] = await db
    .select({ id: invites.id })
    .from(invites)
    .where(and(eq(invites.guildId, guildId), eq(invites.code, code.trim().toUpperCase())))
    .limit(1)
  if (!invite) throw new NotFoundError('Unknown invite')
  const revoked = await drizzleInviteHistoryStore().transaction((s) => s.revokeInvites([invite.id]))
  await publishInviteDeletes(guildId, revoked)
}
