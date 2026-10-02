/**
 * GET /api/admin/overview — AdminOverview: row counts, the media-node summary,
 * online users (Redis `presence:*`) and server info. Admin only (contract §4 Admin API).
 */
import { count, eq, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import pkg from '../../../../../package.json'
import { db } from '@/db/client'
import { channels, guilds, mediaNodes, messages, uploads, users } from '@/db/schema'
import { HEARTBEAT_STALE_AFTER_MS } from '@/grpc/repo'
import { summarizeMediaNodes, toAdminMediaNode, type AdminOverview } from '@/lib/admin'
import { adminRoute } from '@/lib/api-helpers'
import { redis } from '@/lib/events'
import { getLimits } from '@/lib/files'

/** Users with a live presence key that is not 'offline'. SCAN, so it does not block Redis. */
async function countOnlineUsers(): Promise<number> {
  const r = redis()
  let online = 0
  for await (const keys of r.scanStream({ match: 'presence:*', count: 500 }) as AsyncIterable<string[]>) {
    if (keys.length === 0) continue
    online += (await r.mget(keys)).filter((s) => s && s !== 'offline').length
  }
  return online
}

export const GET = adminRoute(async () => {
  const [[u], [a], [g], [c], [m], [up], nodes, onlineUsers] = await Promise.all([
    db.select({ n: count() }).from(users),
    db.select({ n: count() }).from(users).where(eq(users.role, 'admin')),
    db.select({ n: count() }).from(guilds),
    db.select({ n: count() }).from(channels),
    db.select({ n: count() }).from(messages),
    db
      .select({ n: count(), bytes: sql<string>`coalesce(sum(${uploads.size}), 0)::text` })
      .from(uploads),
    db.select().from(mediaNodes),
    countOnlineUsers(),
  ])
  const now = new Date()
  const overview: AdminOverview = {
    counts: {
      users: u.n,
      admins: a.n,
      guilds: g.n,
      channels: c.n,
      messages: m.n,
      uploads: up.n,
      uploadBytes: Number(up.bytes),
    },
    mediaNodes: summarizeMediaNodes(nodes.map((n) => toAdminMediaNode(n, now, HEARTBEAT_STALE_AFTER_MS))),
    onlineUsers,
    server: {
      version: pkg.version,
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      maxUploadBytes: getLimits().maxUploadBytes,
    },
  }
  return NextResponse.json(overview)
})
