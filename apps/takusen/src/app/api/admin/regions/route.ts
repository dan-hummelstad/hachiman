/**
 * GET  /api/admin/regions — AdminRegion[] (all columns, unlike public GET /api/regions).
 * POST /api/admin/regions { code, displayName, lat?, lon?, probeHost?, probePort? } —
 *      201 AdminRegion; 409 when the code exists.
 * Admin only (contract §4 Admin API).
 */
import { NextResponse } from 'next/server'

import { db } from '@/db/client'
import { regions } from '@/db/schema'
import { toAdminRegion } from '@/lib/admin'
import { adminRoute, parseBody } from '@/lib/api-helpers'
import { ConflictError } from '@/lib/errors'
import { listAdminRegions } from '@/lib/admin-stats'
import { regionCodeSchema, regionFieldsSchema } from '@/lib/regions'

const createRegionSchema = regionFieldsSchema.extend({ code: regionCodeSchema })

export const GET = adminRoute(async () => NextResponse.json(await listAdminRegions()))

export const POST = adminRoute(async ({ req }) => {
  const body = await parseBody(req, createRegionSchema)
  const [row] = await db.insert(regions).values(body).onConflictDoNothing().returning()
  if (!row) throw new ConflictError(`Region "${body.code}" already exists`)
  return NextResponse.json(toAdminRegion(row, 0), { status: 201 })
})
