/**
 * GET /api/admin/islands/metrics
 *
 * Admin-only. Returns the LIVE per-island metrics snapshot from Redis joined
 * onto the durable island id set. Polled by the islands admin dashboard's
 * client-side live-metrics section (~7s cadence, matching the publisher).
 *
 * Wire shape:
 *   {
 *     redisConfigured: boolean,         // false → REDIS_URL unset on Oracle
 *     fetchedAt: number,                // unix ms, when the server built the snapshot
 *     readings: Array<{
 *       islandId: string,
 *       activeUsers: number,
 *       cpuPct: number,
 *       bandwidthPct: number,
 *       publishedAt: number,            // unix ms from the publisher
 *     }>
 *   }
 *
 * Islands with NO fresh reading (TTL-expired or never published) are OMITTED
 * from `readings` — the dashboard distinguishes them from "0 users, 0% CPU"
 * by checking presence in this map. This matches the published precedence
 * contract in `scheduler-placement.ts`: absent ≠ zero.
 *
 * NOTE: simple GET-and-poll. If this becomes a bottleneck (many admins, many
 * islands), replace with SSE or a WS push from a background subscriber rather
 * than scaling the poll rate.
 */
import { NextResponse } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { getIslandMetrics } from '@/lib/island-metrics'
import { listIslands } from '@/lib/islands'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  try {
    // Mirror the admin gate on the existing /api/admin/islands route exactly —
    // operator-only data, no backdoor.
    await requireUser({ role: 'admin' })

    // We can't know which ids to query without first reading the durable set.
    // `listIslands` is the same source the durable overview uses, so the live
    // view stays consistent with the rows the page renders.
    const allIslands = await listIslands()
    const ids = allIslands.map((i) => i.id)

    // With REDIS_URL unset, getIslandMetrics resolves to an empty map without
    // ever dialing — preserves the "Oracle works without Redis" posture.
    // We surface the configured flag separately so the dashboard can render
    // a "live metrics unavailable" banner rather than silently showing
    // every island as "no fresh data".
    const redisConfigured = Boolean(process.env.REDIS_URL)
    const readingsMap = await getIslandMetrics(ids)

    const readings = ids.flatMap((islandId) => {
      const reading = readingsMap.get(islandId)
      if (!reading) return []
      return [
        {
          islandId,
          activeUsers: reading.metrics.activeUsers,
          cpuPct: reading.metrics.cpuPct,
          bandwidthPct: reading.metrics.bandwidthPct,
          publishedAt: reading.publishedAt,
        },
      ]
    })

    return NextResponse.json({
      redisConfigured,
      fetchedAt: Date.now(),
      readings,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
