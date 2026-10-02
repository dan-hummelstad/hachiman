/**
 * Voice-region registry helpers: the `regions` table read + the region-code
 * validator shared by `GET /api/regions` and the region-recommendation route.
 */
import { asc } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db/client'
import { regions, type Region } from '@/db/schema'

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

export async function listRegions(): Promise<Region[]> {
  return await db.select().from(regions).orderBy(asc(regions.displayName))
}
