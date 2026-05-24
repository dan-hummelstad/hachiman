/**
 * GET /api/invites/[code] — public redemption. No auth required.
 *
 * Increments useCount on success. Returns the signed takusen:// URI and a
 * thin server descriptor.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { redeemInviteToUri } from '@/lib/invite-signing'

interface RouteContext {
  params: Promise<{ code: string }>
}

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { code } = await ctx.params
    const { joinUri, server } = await redeemInviteToUri(code)
    return NextResponse.json({
      joinUri,
      server: {
        slug: server.slug,
        name: server.name,
        verifiedAt: server.verifiedAt,
        host: server.host,
        port: server.port,
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
