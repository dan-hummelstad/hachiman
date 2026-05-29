/**
 * GET /api/regions
 *
 * Public, no auth — returns the known voice regions and the endpoint a
 * latency-capable client probes to measure client→region RTT. Mirrors the
 * public posture of `api/servers/search`.
 *
 * A client (the Electron host; browsers can't open raw sockets) fetches this,
 * probes each `{ probeHost, probePort }` with `probeRegionsRtt` from
 * `@hachiman/hachiman-node`, and POSTs the measured RTTs to
 * `/api/servers/recommend-region` for a real region recommendation.
 *
 * Only the probe-relevant projection is exposed (`lat`/`lon`/`createdAt` are
 * internal to the future placement scorer and intentionally withheld).
 */
import { NextResponse } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { listRegions } from '@/lib/servers'

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
