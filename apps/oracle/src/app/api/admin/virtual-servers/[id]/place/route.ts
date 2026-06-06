/**
 * POST /api/admin/virtual-servers/[id]/place
 *
 * Manually triggers the bin-packing scheduler for a single unplaced
 * virtual server. The intended use is "I just added an island; place
 * this waiting vServer onto it now" — a deterministic test-mode hook
 * until either:
 *   (a) a background reconciler sweeps unplaced vServers periodically, or
 *   (b) island-create auto-runs placement for everything unplaced in the
 *       new island's region.
 *
 * Admin-only. The scheduler's safety guarantees (only `inactive` vServers
 * are placeable; region must be set; only `active` islands considered;
 * hard cap on `maxVservers`) all run unchanged — this endpoint is just
 * the missing trigger, not a policy override. A vServer with no region
 * surfaces as `no-capacity`, not as a 4xx.
 *
 * Response shape:
 *   200 — `{ result, vServer }` from `scheduleVServerPlacement`. When
 *         `result.chosen === null` the vServer was NOT placed (no
 *         capacity / no region); the caller can read `result.reason` to
 *         distinguish.
 *   404 — vServer id doesn't exist.
 *   409 — vServer status disallows placement (not `inactive`).
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { scheduleVServerPlacement } from '@/lib/scheduler-placement'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    await requireUser({ role: 'admin' })
    const { id } = await ctx.params
    // Empty metrics map: rely solely on the Redis-backed live metrics
    // path inside the scheduler. Islands without a fresh reading score
    // with `MISSING_ISLAND_METRICS` (zeros) — desirable for manual
    // testing on a fresh dev island that hasn't published yet.
    const outcome = await scheduleVServerPlacement(id, new Map())
    return NextResponse.json(outcome)
  } catch (err) {
    return errorResponse(err)
  }
}
