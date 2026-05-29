/**
 * POST /api/servers/recommend-region
 *
 * Recommend a voice region for a server based on *client-measured* round-trip
 * times to each candidate region, not the owner's location. The client probes
 * each region (see the RTT prober in `@hachiman/hachiman-node` / the design in
 * PLACEMENT-DESIGN.md), POSTs the measurements here, and gets back a ranked
 * list + the recommended region code.
 *
 * Region affinity (lowest measured RTT) dominates; optional per-region load is
 * a secondary tiebreaker. All scoring is delegated to the pure `scorePlacement`
 * in `@/lib/placement` — this route is just auth + validation + candidate
 * resolution (mirrors `api/servers/search` + `api/servers/route` patterns).
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
 * Unknown region codes (not in the registry's `regions` table) are ignored so a
 * stale client can't inject arbitrary placements. Regions present in the
 * registry but missing from `measurements` are reported as `unmeasured`.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { requireUser } from '@/lib/auth-helpers'
import { errorResponse } from '@/lib/api-helpers'
import { scorePlacement, type RegionCandidate } from '@/lib/placement'
import { regionCodeSchema } from '@/lib/server-schemas'
import { listRegions } from '@/lib/servers'

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
  // RTT in ms. Non-negative + finite. `null` means "probe failed / unreachable"
  // — the scorer treats it as unrankable rather than excluding it from the
  // response, so the UI can show "unreachable" vs. simply "not yet measured".
  rttMs: z.number().min(0).finite().nullable(),
  load: loadSchema,
})

const recommendRegionSchema = z.object({
  measurements: z.array(measurementSchema).max(64),
  rttToleranceMs: z.number().min(0).max(1000).optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // Placement recommendations inform a server-owner action (initial region /
    // re-home), so require an authenticated user — same posture as the other
    // mutating server routes.
    await requireUser()

    const body = await req.json()
    const { measurements, rttToleranceMs } = recommendRegionSchema.parse(body)

    // Candidates are authoritative: only regions that exist in the registry can
    // be recommended. This also lets us report which known regions the client
    // never measured.
    const regions = await listRegions()
    const knownCodes = new Set(regions.map((r) => r.code))

    // Index the client's measurements by region, keeping only known regions.
    const byCode = new Map<string, RegionCandidate>()
    for (const m of measurements) {
      if (!knownCodes.has(m.region)) continue
      byCode.set(m.region, { code: m.region, rttMs: m.rttMs, load: m.load })
    }

    // Score across every known region; a known region the client didn't measure
    // becomes an unmeasured candidate (rttMs undefined → unrankable).
    const candidates: RegionCandidate[] = regions.map(
      (r) => byCode.get(r.code) ?? { code: r.code },
    )

    const result = scorePlacement(candidates, { rttToleranceMs })

    return NextResponse.json({
      recommended: result.recommended,
      ranking: result.ranking,
      // Known regions with no usable RTT this round (client didn't probe them
      // or the probe failed). `unrankable` from the scorer == these codes.
      unmeasured: result.unrankable,
      // Echo the candidate set so the UI can label codes with display names.
      regions: regions.map((r) => ({ code: r.code, displayName: r.displayName })),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
