/** The public voice-region status on the landing page. */
import { db } from '@/db/client'
import { mediaNodes } from '@/db/schema'
import { HEARTBEAT_STALE_AFTER_MS } from '@/grpc/repo'
import { nodesByRegion, toAdminMediaNode, type MediaNodeSummary } from '@/lib/admin'
import { listRegions } from '@/lib/regions'

export interface RegionStatus {
  code: string
  displayName: string
  /** The admin summary of the region's media nodes; `active` nodes are the ones placement can pick. */
  nodes: MediaNodeSummary
}

/** Each region of the table with its media-node summary. */
export async function listRegionStatus(now = new Date()): Promise<RegionStatus[]> {
  const [all, nodes] = await Promise.all([listRegions(), db.select().from(mediaNodes)])
  const views = nodes.map((n) => toAdminMediaNode(n, now, HEARTBEAT_STALE_AFTER_MS))
  // The table's regions come first, in its order; node-only regions after them are not shown.
  const summaries = nodesByRegion(views, all.map((r) => r.code))
  return all.map((r, i) => ({ code: r.code, displayName: r.displayName, nodes: summaries[i].nodes }))
}
