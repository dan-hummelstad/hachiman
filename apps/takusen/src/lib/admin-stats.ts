/**
 * Counts and search for the admin dashboard: the sidebar badges, the overview,
 * the OIDC client activity, the guilds per region and the ⌘K search
 * (contract §4 Admin API).
 */
import { asc, count, countDistinct, eq, gt, ilike, or, sql } from 'drizzle-orm'

import { db } from '@/db/client'
import { channels, guilds, mediaNodes, oidcAdapterPayloads, oidcClients, regions, users } from '@/db/schema'
import { HEARTBEAT_STALE_AFTER_MS } from '@/grpc/repo'
import {
  ADMIN_SEARCH_LIMIT,
  likePattern,
  toAdminMediaNode,
  toAdminRegion,
  type AdminCounts,
  type AdminRegion,
  type AdminSearchResult,
} from '@/lib/admin'
import { listGuilds } from '@/lib/admin-guilds'
import { listUsers, unverifiedUser } from '@/lib/admin-users'
import { listRegions } from '@/lib/regions'
import { liveGrantOf } from '@/lib/session-revocation'

const WEEK_MS = 7 * 24 * 3600 * 1000

export async function getAdminCounts(now: Date = new Date()): Promise<AdminCounts> {
  const [[u], [a], [unverified], [signedIn], [fresh], [g], [c], [n], [r], [o]] = await Promise.all([
    db.select({ n: count() }).from(users),
    db.select({ n: count() }).from(users).where(eq(users.role, 'admin')),
    db.select({ n: count() }).from(users).where(unverifiedUser),
    db
      .select({ n: countDistinct(sql`${oidcAdapterPayloads.payload}->>'accountId'`) })
      .from(oidcAdapterPayloads)
      .where(liveGrantOf()),
    db
      .select({ n: count() })
      .from(users)
      .where(gt(users.createdAt, new Date(now.getTime() - WEEK_MS))),
    db.select({ n: count() }).from(guilds),
    db.select({ n: count() }).from(channels),
    db.select({ n: count() }).from(mediaNodes),
    db.select({ n: count() }).from(regions),
    db.select({ n: count() }).from(oidcClients),
  ])
  return {
    users: u?.n ?? 0,
    admins: a?.n ?? 0,
    unverifiedUsers: unverified?.n ?? 0,
    signedInUsers: signedIn?.n ?? 0,
    newUsers7d: fresh?.n ?? 0,
    guilds: g?.n ?? 0,
    channels: c?.n ?? 0,
    mediaNodes: n?.n ?? 0,
    regions: r?.n ?? 0,
    oidcClients: o?.n ?? 0,
  }
}

/** Per OIDC client id: the users with a live grant and the live grants. */
export async function oidcClientActivity(): Promise<Map<string, { activeUsers: number; activeSessions: number }>> {
  const clientId = sql<string>`${oidcAdapterPayloads.payload}->>'clientId'`
  const rows = await db
    .select({
      clientId,
      activeUsers: countDistinct(sql`${oidcAdapterPayloads.payload}->>'accountId'`),
      activeSessions: count(),
    })
    .from(oidcAdapterPayloads)
    .where(liveGrantOf())
    .groupBy(clientId)
  return new Map(rows.map((r) => [r.clientId, { activeUsers: r.activeUsers, activeSessions: r.activeSessions }]))
}

/** Guilds per region code. */
export async function guildsPerRegion(): Promise<Map<string, number>> {
  const rows = await db
    .select({ region: guilds.region, n: count() })
    .from(guilds)
    .where(sql`${guilds.region} IS NOT NULL`)
    .groupBy(guilds.region)
  return new Map(rows.flatMap((r) => (r.region ? [[r.region, r.n] as const] : [])))
}

export async function listAdminRegions(): Promise<AdminRegion[]> {
  const [rows, perRegion] = await Promise.all([listRegions(), guildsPerRegion()])
  return rows.map((r) => toAdminRegion(r, perRegion.get(r.code) ?? 0))
}

export async function regionGuildCount(code: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(guilds).where(eq(guilds.region, code))
  return row?.n ?? 0
}

/** Up to ADMIN_SEARCH_LIMIT of each kind. Users by email or name, guilds by name, nodes and regions by code or name. */
export async function adminSearch(query: string): Promise<AdminSearchResult> {
  const term = query.trim()
  if (term === '') return { users: [], guilds: [], mediaNodes: [], regions: [] }
  const pattern = likePattern(term)
  const page = { query: term, cursor: null, limit: ADMIN_SEARCH_LIMIT }
  const [userPage, guildPage, nodes, regionRows, perRegion] = await Promise.all([
    listUsers(page),
    listGuilds(page),
    db
      .select()
      .from(mediaNodes)
      .where(or(ilike(mediaNodes.nodeId, pattern), ilike(mediaNodes.region, pattern)))
      .orderBy(asc(mediaNodes.nodeId))
      .limit(ADMIN_SEARCH_LIMIT),
    db
      .select()
      .from(regions)
      .where(or(ilike(regions.code, pattern), ilike(regions.displayName, pattern)))
      .orderBy(asc(regions.displayName))
      .limit(ADMIN_SEARCH_LIMIT),
    guildsPerRegion(),
  ])
  const now = new Date()
  return {
    users: userPage.items,
    guilds: guildPage.items,
    mediaNodes: nodes.map((n) => toAdminMediaNode(n, now, HEARTBEAT_STALE_AFTER_MS)),
    regions: regionRows.map((r) => toAdminRegion(r, perRegion.get(r.code) ?? 0)),
  }
}
