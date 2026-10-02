/**
 * GET /api/regions
 *
 * Public, no auth — returns the known voice regions and the endpoint a
 * latency-capable client probes to measure client→region RTT.
 *
 * A client (the Electron host; browsers can't open raw sockets) fetches this,
 * probes each `{ probeHost, probePort }` with `probeRegionsRtt` from
 * `@hachiman/client`, and POSTs the measured RTTs to
 * `/api/v1/regions/recommend` for a real region recommendation.
 *
 * Only the probe-relevant projection is exposed (`lat`/`lon`/`createdAt` are
 * internal to the future placement scorer and intentionally withheld).
 */
import { NextResponse } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { listRegions } from '@/lib/regions'

export async function GET(): Promise<NextResponse> {
  try {
    const regions = await listRegions()
    return NextResponse.json(
      regions.map((r) => ({
        code: r.code,
        displayName: r.displayName,
        probeHost: r.probeHost,
        probePort: r.probePort,
      })),
    )
  } catch (err) {
    return errorResponse(err)
  }
}
