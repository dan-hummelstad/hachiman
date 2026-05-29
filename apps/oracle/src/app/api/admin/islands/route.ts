/**
 * GET /api/admin/islands
 *
 * Admin-only. Returns the control-plane islands overview: each island with the
 * managed virtual servers placed on it, plus the set of unplaced vServers.
 *
 * LIVE island metrics (active users / CPU / bandwidth) are intentionally NOT
 * included — they live in Redis and are supplied to the bin-packing scheduler
 * at scoring time, not persisted here (see ISLAND-PLATFORM.md).
 */
import { NextResponse } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { getIslandsOverview } from '@/lib/islands'

export async function GET(): Promise<NextResponse> {
  try {
    await requireUser({ role: 'admin' })
    const overview = await getIslandsOverview()
    return NextResponse.json(overview)
  } catch (err) {
    return errorResponse(err)
  }
}
