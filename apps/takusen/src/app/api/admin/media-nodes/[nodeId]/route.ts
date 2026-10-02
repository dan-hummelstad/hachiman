/**
 * PATCH  /api/admin/media-nodes/:nodeId { status: 'active' | 'draining' } —
 *        AdminMediaNode. 'draining' sets admin_drain: placement skips the node
 *        through its heartbeats and re-registers until 'active' clears it.
 *        Sessions already on the node stay.
 * DELETE /api/admin/media-nodes/:nodeId — 204. Removes the registry row,
 *        admin_drain included. A node that still runs registers again on its
 *        next heartbeat, as active.
 * Admin only (contract §4 Admin API).
 */
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { mediaNodes } from '@/db/schema'
import { drizzleMediaNodesRepo, HEARTBEAT_STALE_AFTER_MS } from '@/grpc/repo'
import { toAdminMediaNode } from '@/lib/admin'
import { adminRoute, noContent, parseBody } from '@/lib/api-helpers'
import { NotFoundError } from '@/lib/errors'

const updateNodeSchema = z.object({ status: z.enum(['active', 'draining']) })

export const PATCH = adminRoute<{ nodeId: string }>(async ({ req, params }) => {
  const { status } = await parseBody(req, updateNodeSchema)
  const row = await drizzleMediaNodesRepo.setAdminDrain(params.nodeId, status === 'draining')
  if (!row) throw new NotFoundError('Unknown media node')
  return NextResponse.json(toAdminMediaNode(row, new Date(), HEARTBEAT_STALE_AFTER_MS))
})

export const DELETE = adminRoute<{ nodeId: string }>(async ({ params }) => {
  const deleted = await db
    .delete(mediaNodes)
    .where(eq(mediaNodes.nodeId, params.nodeId))
    .returning({ nodeId: mediaNodes.nodeId })
  if (deleted.length === 0) throw new NotFoundError('Unknown media node')
  return noContent()
})
