/**
 * /api/admin/islands
 *
 * Admin-only. GET returns the control-plane islands overview (each island
 * with placed vServers + the set of unplaced vServers). POST manually
 * registers a new island row — the "Add Island" admin-dashboard entry
 * point used when a Grumble process exists but no scheduler has
 * auto-registered it yet.
 *
 * LIVE island metrics (active users / CPU / bandwidth) are intentionally
 * NOT included here — they live in Redis and are supplied to the
 * bin-packing scheduler at scoring time, not persisted (see
 * ISLAND-PLATFORM.md).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { createIsland, getIslandsOverview } from '@/lib/islands'

// Island lifecycle states the operator can stamp at create time. The
// values mirror `islandStatusEnum` in db/schema.ts; using a literal union
// here keeps the API contract tight without importing the Drizzle enum.
const islandStatusSchema = z.enum(['provisioning', 'active', 'draining', 'down'])

const createIslandSchema = z.object({
  // DNS name or IP — keep validation light. The scheduler dials this
  // directly so an invalid value will surface as a connect-time error
  // rather than a constraint violation here.
  host: z.string().trim().min(1, 'Host is required').max(253, 'Host is too long'),
  // gRPC port; not the Mumble voice port. Default 9090 matches the
  // managed-mode env example.
  grpcPort: z
    .number()
    .int('gRPC port must be an integer')
    .min(1, 'gRPC port must be between 1 and 65535')
    .max(65535, 'gRPC port must be between 1 and 65535'),
  // FK to `regions.code` (ON DELETE RESTRICT). A bogus code surfaces as
  // a 23503 FK violation; we let that bubble up rather than pre-check.
  region: z.string().trim().min(1, 'Region is required'),
  status: islandStatusSchema.optional(),
  maxVservers: z
    .number()
    .int('Max vServers must be an integer')
    .min(1, 'Max vServers must be at least 1')
    .max(10_000, 'Max vServers is unreasonably high')
    .optional(),
})

export async function GET(): Promise<NextResponse> {
  try {
    await requireUser({ role: 'admin' })
    const overview = await getIslandsOverview()
    return NextResponse.json(overview)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireUser({ role: 'admin' })
    const body = await req.json()
    const parsed = createIslandSchema.parse(body)
    const island = await createIsland(parsed)
    return NextResponse.json(island, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
