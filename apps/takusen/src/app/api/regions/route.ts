/**
 * GET /api/regions
 *
 * Public, no auth — returns the known voice regions and the endpoint a
 * latency-capable client probes to measure client→region RTT.
 *
 * The shared UI (TakusenService.listRegions) fetches this and hands each
 * `{ probeHost, probePort }` to `IPlatformService.probeRegions`. Only the
 * Electron host probes (a TCP connect RTT in its main process; browsers can't
 * open raw sockets). The UI then POSTs the measured RTTs to
 * `/api/v1/regions/recommend` for a region recommendation.
 *
 * Only the probe-relevant projection is exposed (`lat`/`lon`/`createdAt` stay
 * internal and are intentionally withheld).
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
