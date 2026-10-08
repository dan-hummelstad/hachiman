/**
 * Voice-region registry helpers: the `regions` table read + the region-code
 * validator shared by `GET /api/regions`, the region-recommendation route and
 * the admin region routes.
 */
import { asc } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db/client'
import { mediaNodes, regions, type Region } from '@/db/schema'
import { HEARTBEAT_STALE_AFTER_MS } from '@/grpc/repo'
import { summarizeMediaNodes, toAdminMediaNode, type MediaNodeSummary } from '@/lib/admin'

/**
 * Region codes are short machine identifiers (e.g. "us-east"). The
 * authoritative set lives in the `regions` table; this only rejects
 * obviously-bogus shapes before they hit the database.
 */
export const regionCodeSchema = z
  .string()
  .trim()
  .min(2, 'Region code is too short')
  .max(32, 'Region code is too long')
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'Region code must be lowercase kebab-case (a-z, 0-9, hyphens)',
  )

/** The editable region columns (admin POST / PATCH). */
export const regionFieldsSchema = z.object({
  displayName: z.string().trim().min(1).max(64),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lon: z.number().min(-180).max(180).nullable().optional(),
  probeHost: z.string().trim().min(1).max(253).nullable().optional(),
  probePort: z.number().int().min(1).max(65535).optional(),
})

export async function listRegions(): Promise<Region[]> {
  return await db.select().from(regions).orderBy(asc(regions.displayName))
}

export interface RegionStatus {
  code: string
  displayName: string
  /** The admin summary of the region's media nodes; `active` nodes are the ones placement can pick. */
  nodes: MediaNodeSummary
}

/** Each region with its media-node summary, for the public status on the landing page. */
export async function listRegionStatus(now = new Date()): Promise<RegionStatus[]> {
  const [all, nodes] = await Promise.all([listRegions(), db.select().from(mediaNodes)])
  const views = nodes.map((n) => toAdminMediaNode(n, now, HEARTBEAT_STALE_AFTER_MS))
  return all.map((r) => ({
    code: r.code,
    displayName: r.displayName,
    nodes: summarizeMediaNodes(views.filter((n) => n.region === r.code)),
  }))
}
