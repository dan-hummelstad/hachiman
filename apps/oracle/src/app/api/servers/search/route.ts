/**
 * GET /api/servers/search?q=...&limit=...&offset=...
 *
 * Public, no auth — returns verified servers. Filters by name (ILIKE) or
 * exact slug match.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { listPublicServers } from '@/lib/servers'

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url)
    const q = searchParams.get('q') ?? undefined
    const limitRaw = searchParams.get('limit')
    const offsetRaw = searchParams.get('offset')

    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
    const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : undefined

    const result = await listPublicServers({
      search: q,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    })

    return NextResponse.json(result)
  } catch (err) {
    return errorResponse(err)
  }
}
