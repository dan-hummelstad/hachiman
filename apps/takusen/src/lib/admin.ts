/**
 * Pure helpers for the deployment admin API (`/api/admin`, contract §4 Admin
 * API): list paging, the self-change guard, and the admin wire shapes. No DB or
 * Redis here, so admin.test.ts runs without either.
 */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm'
import { z } from 'zod'

import type { MediaNode, Region } from '@/db/schema'
import { ConflictError, ValidationError } from '@/lib/errors'
import { UUID_RE } from '@/lib/ids'

export const ADMIN_PAGE_DEFAULT = 50
export const ADMIN_PAGE_MAX = 100

/** Keyset position in a `created_at DESC, id DESC` list. `ts` keeps Postgres'
 *  microseconds: a JS Date would round them and skip rows. */
export interface Cursor {
  ts: string
  id: string
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

/** Select this as `cursor` next to `id`: `createdAt` as UTC ISO with microseconds. */
export function cursorColumn(createdAt: AnyColumn): SQL<string> {
  return sql<string>`to_char(${createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

/** Rows after `c` in `createdAt DESC, id DESC` order. */
export function afterCursor(createdAt: AnyColumn, id: AnyColumn, c: Cursor): SQL {
  return sql`(${createdAt}, ${id}) < (${c.ts}::timestamptz, ${c.id}::uuid)`
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.ts}|${c.id}`).toString('base64url')
}

export function decodeCursor(raw: string): Cursor {
  const [ts, id, extra] = Buffer.from(raw, 'base64url').toString().split('|')
  if (extra !== undefined || !ts || !id || !TS_RE.test(ts) || !UUID_RE.test(id)) {
    throw new ValidationError('Invalid cursor')
  }
  return { ts, id }
}

/** `rows` was fetched with `limit + 1`; the extra row only signals another page. */
export function toPage<R extends { cursor: string; id: string }, T>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
): Page<T> {
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return {
    items: items.map(map),
    nextCursor: rows.length > limit && last ? encodeCursor({ ts: last.cursor, id: last.id }) : null,
  }
}

const listQuerySchema = z.object({
  query: z.string().trim().max(100).default(''),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX).default(ADMIN_PAGE_DEFAULT),
})

export interface ListQuery {
  query: string
  cursor: Cursor | null
  limit: number
}

export function parseListQuery(params: URLSearchParams): ListQuery {
  const q = listQuerySchema.parse({
    query: params.get('query') ?? undefined,
    cursor: params.get('cursor') || undefined,
    limit: params.get('limit') ?? undefined,
  })
  return { query: q.query, cursor: q.cursor ? decodeCursor(q.cursor) : null, limit: q.limit }
}

/** `%term%` for ILIKE, with the LIKE metacharacters in `term` taken literally. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`
}

/**
 * An admin may not demote or delete themselves. The actor is a locked admin
 * row (lockAdmins in admin-users.ts), so this alone keeps at least one admin.
 */
export function assertAdminChange(actorId: string, targetId: string, change: 'demote' | 'delete'): void {
  if (targetId === actorId) {
    throw new ConflictError(
      change === 'demote' ? 'You cannot remove your own admin role' : 'You cannot delete your own account',
    )
  }
}

export type UserRole = 'user' | 'admin'

export interface AdminUser {
  id: string
  email: string
  displayName: string
  role: UserRole
  /** Avatar upload key, or null. */
  avatar: string | null
  emailVerified: boolean
  /** Live OIDC grants: one per Hachiman sign-in. */
  activeSessions: number
  createdAt: string
}

/** `unverified`: no verified email. `signed_in`: at least one live Hachiman session. */
export type AdminUserFilter = 'unverified' | 'signed_in'

export interface AdminGuild {
  id: string
  name: string
  /** Icon upload key, or null. */
  icon: string | null
  region: string | null
  owner: { id: string; email: string; displayName: string; avatar: string | null }
  memberCount: number
  channelCount: number
  createdAt: string
}

export interface AdminInvite {
  code: string
  uses: number
  maxUses: number | null
  expiresAt: string | null
  /** An invite with history (§12.11.4). */
  hasHistory: boolean
  createdBy: { id: string; displayName: string }
  createdAt: string
}

export interface AdminGuildDetail extends AdminGuild {
  /** Banner upload key, or null. */
  banner: string | null
  /** Members with a presence that is not offline. */
  onlineCount: number
  /** Pages in the guild's pages channels. */
  pageCount: number
  /** Usable invites only, newest first. */
  invites: AdminInvite[]
}

export interface AdminMediaNode {
  nodeId: string
  region: string
  status: string
  adminDrain: boolean
  stale: boolean
  signalingUrl: string
  version: string
  activeSessions: number
  maxSessions: number
  cpuFraction: number
  lastHeartbeatAt: string
}

export function toAdminMediaNode(n: MediaNode, now: Date, staleAfterMs: number): AdminMediaNode {
  return {
    nodeId: n.nodeId,
    region: n.region,
    status: n.status,
    adminDrain: n.adminDrain,
    stale: now.getTime() - n.lastHeartbeatAt.getTime() >= staleAfterMs,
    signalingUrl: n.signalingUrl,
    version: n.version,
    activeSessions: n.activeSessions,
    maxSessions: n.capacity.max_sessions,
    cpuFraction: n.cpuFraction,
    lastHeartbeatAt: n.lastHeartbeatAt.toISOString(),
  }
}

export interface MediaNodeSummary {
  total: number
  /** Fresh heartbeat and status `active`: placement can pick these. */
  active: number
  /** Fresh heartbeat and status `draining`. */
  draining: number
  /** No heartbeat inside the freshness window (includes `dead`). */
  stale: number
  /** Sum of `activeSessions` over fresh nodes: the live voice connections. */
  sessions: number
  /** Sum of `maxSessions` over fresh `active` nodes. */
  capacity: number
}

export function summarizeMediaNodes(nodes: readonly AdminMediaNode[]): MediaNodeSummary {
  const s: MediaNodeSummary = { total: nodes.length, active: 0, draining: 0, stale: 0, sessions: 0, capacity: 0 }
  for (const n of nodes) {
    if (n.stale) {
      s.stale++
      continue
    }
    s.sessions += n.activeSessions
    if (n.status === 'active') {
      s.active++
      s.capacity += n.maxSessions
    } else if (n.status === 'draining') {
      s.draining++
    }
  }
  return s
}

export interface RegionLoad {
  region: string
  /** Sum of `activeSessions` over the fresh nodes of the region. */
  sessions: number
  /** Sum of `maxSessions` over the fresh `active` nodes of the region. */
  capacity: number
  nodes: number
  stale: number
  draining: number
}

/**
 * Voice load per region: every region in `regionCodes` (in that order), then
 * any other region that a node names, by code.
 */
export function regionLoad(nodes: readonly AdminMediaNode[], regionCodes: readonly string[]): RegionLoad[] {
  const byRegion = new Map<string, RegionLoad>()
  const entry = (region: string) => {
    let e = byRegion.get(region)
    if (!e) {
      e = { region, sessions: 0, capacity: 0, nodes: 0, stale: 0, draining: 0 }
      byRegion.set(region, e)
    }
    return e
  }
  for (const code of regionCodes) entry(code)
  for (const n of [...nodes].sort((a, b) => a.region.localeCompare(b.region))) {
    const e = entry(n.region)
    e.nodes++
    if (n.stale) {
      e.stale++
      continue
    }
    e.sessions += n.activeSessions
    if (n.status === 'active') e.capacity += n.maxSessions
    else if (n.status === 'draining') e.draining++
  }
  return [...byRegion.values()]
}

/** The badge counts of the admin sidebar, and the user facts of the overview. */
export interface AdminCounts {
  users: number
  admins: number
  /** Users with no verified email. */
  unverifiedUsers: number
  /** Users with at least one live Hachiman session (OIDC grant). */
  signedInUsers: number
  /** Users created in the last 7 days. */
  newUsers7d: number
  guilds: number
  channels: number
  mediaNodes: number
  regions: number
  oidcClients: number
}

export interface AdminOverview {
  counts: AdminCounts & {
    messages: number
    uploads: number
    uploadBytes: number
  }
  mediaNodes: MediaNodeSummary
  /** Every region, then node regions that are not in the table. */
  regionLoad: RegionLoad[]
  /** Users with a live presence that is not offline. */
  onlineUsers: number
  server: { version: string; nodeVersion: string; uptimeSeconds: number; maxUploadBytes: number }
}

export interface AdminOidcClient {
  id: string
  clientId: string
  isPublic: boolean
  redirectUris: string[]
  scopes: string[]
  /** Users with a live grant of the client. */
  activeUsers: number
  /** Live grants of the client: one per sign-in. */
  activeSessions: number
  createdAt: string
}

export interface AdminRegion {
  code: string
  displayName: string
  lat: number | null
  lon: number | null
  probeHost: string | null
  probePort: number
  /** Guilds homed in the region. */
  guildCount: number
  createdAt: string
}

export function toAdminRegion(r: Region, guildCount: number): AdminRegion {
  return {
    code: r.code,
    displayName: r.displayName,
    lat: r.lat,
    lon: r.lon,
    probeHost: r.probeHost,
    probePort: r.probePort,
    guildCount,
    createdAt: r.createdAt.toISOString(),
  }
}

export interface AdminSearchResult {
  users: AdminUser[]
  guilds: AdminGuild[]
  mediaNodes: AdminMediaNode[]
  regions: AdminRegion[]
}

export const ADMIN_SEARCH_LIMIT = 5
