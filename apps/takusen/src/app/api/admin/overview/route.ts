/**
 * GET /api/admin/overview — AdminOverview: row counts, the media-node summary,
 * the voice load per region, online users (Redis `presence:*`) and server info. Admin only (contract §4 Admin API).
 */
import { count, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import pkg from '../../../../../package.json'
import { db } from '@/db/client'
import { mediaNodes, messages, uploads } from '@/db/schema'
import { HEARTBEAT_STALE_AFTER_MS } from '@/grpc/repo'
import { nodesByRegion, summarizeMediaNodes, toAdminMediaNode, type AdminOverview } from '@/lib/admin'
import { adminCounts } from '@/lib/admin-stats'
import { adminRoute } from '@/lib/api-helpers'
import { redis } from '@/lib/events'
import { getLimits } from '@/lib/files'
import { listRegions } from '@/lib/regions'

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
  const [counts, [m], [up], nodes, regionRows, onlineUsers] = await Promise.all([
    adminCounts(),
    db.select({ n: count() }).from(messages),
    db
      .select({ n: count(), bytes: sql<string>`coalesce(sum(${uploads.size}), 0)::text` })
      .from(uploads),
    db.select().from(mediaNodes),
    listRegions(),
    countOnlineUsers(),
  ])
  const now = new Date()
  const adminNodes = nodes.map((n) => toAdminMediaNode(n, now, HEARTBEAT_STALE_AFTER_MS))
  const overview: AdminOverview = {
    counts: {
      ...counts,
      messages: m?.n ?? 0,
      uploads: up?.n ?? 0,
      uploadBytes: Number(up?.bytes ?? 0),
    },
    mediaNodes: summarizeMediaNodes(adminNodes),
    regionLoad: nodesByRegion(adminNodes, regionRows.map((r) => r.code)),
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
