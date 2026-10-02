/**
 * POST /api/v1/regions/recommend
 *
 * Recommend a voice region for a guild based on *client-measured* round-trip
 * times to each candidate region. The client probes each region (GET
 * /api/regions → `probeHost`/`probePort`), POSTs the measurements here, and
 * gets back a ranked list + the recommended region code.
 *
 * Region affinity (lowest measured RTT) dominates; optional per-region load is
 * a secondary tiebreaker. All scoring is delegated to the pure `scorePlacement`
 * in `@/lib/placement` — this route is just auth + validation + candidate
 * resolution.
 *
 * Request body:
 *   {
 *     "measurements": [
 *       { "region": "us-east", "rttMs": 32,
 *         "load"?: { activeUsers, maxUsers, cpuPct, bandwidthPct } },
 *       ...
 *     ],
 *     "rttToleranceMs"?: 15
 *   }
 *
 * Unknown region codes (not in the `regions` table) are ignored so a stale
 * client can't inject arbitrary placements. Known regions missing from
 * `measurements` are reported as `unmeasured`.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { scorePlacement, type RegionCandidate } from '@/lib/placement'
import { listRegions, regionCodeSchema } from '@/lib/regions'

const loadSchema = z
  .object({
    activeUsers: z.number().int().min(0).optional(),
    maxUsers: z.number().int().min(0).optional(),
    cpuPct: z.number().min(0).max(1).optional(),
    bandwidthPct: z.number().min(0).max(1).optional(),
  })
  .optional()

const measurementSchema = z.object({
  region: regionCodeSchema,
  // `null` means "probe failed / unreachable" — the scorer treats it as
  // unrankable rather than dropping it, so the UI can show "unreachable".
  rttMs: z.number().min(0).finite().nullable(),
  load: loadSchema,
})

const recommendRegionSchema = z.object({
  measurements: z.array(measurementSchema).max(64),
  rttToleranceMs: z.number().min(0).max(1000).optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireUser()
    const { measurements, rttToleranceMs } = await parseBody(req, recommendRegionSchema)

    const regions = await listRegions()
    const knownCodes = new Set(regions.map((r) => r.code))

    const byCode = new Map<string, RegionCandidate>()
    for (const m of measurements) {
      if (!knownCodes.has(m.region)) continue
      byCode.set(m.region, { code: m.region, rttMs: m.rttMs, load: m.load })
    }

    // Every known region is a candidate; unmeasured ones are unrankable.
    const candidates: RegionCandidate[] = regions.map(
      (r) => byCode.get(r.code) ?? { code: r.code },
    )
    const result = scorePlacement(candidates, { rttToleranceMs })

    return NextResponse.json({
      recommended: result.recommended,
      ranking: result.ranking,
      unmeasured: result.unrankable,
      // Echo the candidate set so the UI can label codes with display names.
      regions: regions.map((r) => ({ code: r.code, displayName: r.displayName })),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
