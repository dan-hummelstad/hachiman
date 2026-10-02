/**
 * GET /api/admin/media-nodes — AdminMediaNode[] by region, then node id.
 * Admin only (contract §4 Admin API).
 */
import { asc } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/db/client'
import { mediaNodes } from '@/db/schema'
import { HEARTBEAT_STALE_AFTER_MS } from '@/grpc/repo'
import { toAdminMediaNode } from '@/lib/admin'
import { adminRoute } from '@/lib/api-helpers'

export const GET = adminRoute(async () => {
  const rows = await db.select().from(mediaNodes).orderBy(asc(mediaNodes.region), asc(mediaNodes.nodeId))
  const now = new Date()
  return NextResponse.json(rows.map((n) => toAdminMediaNode(n, now, HEARTBEAT_STALE_AFTER_MS)))
})
