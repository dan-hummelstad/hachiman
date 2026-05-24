/**
 * POST /api/me/server-tokens — mint an opaque access token bound to the
 * given Oracle-registered server's OIDC client and the signed-in user.
 * The Mumble server validates it via /api/oidc/token/introspection using
 * its own client_id+secret; panva's introspection naturally returns
 * `active: false` for any other client, which is exactly the audience
 * binding we want.
 *
 * Response shape is locked to { accessToken, expiresAt (unix seconds),
 * scope } — agent C consumes this directly.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { mintServerToken } from '@/lib/server-tokens'

const bodySchema = z.object({
  serverId: z.string().uuid(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const body = await req.json()
    const { serverId } = bodySchema.parse(body)
    const minted = await mintServerToken(session.user.id, serverId)
    return NextResponse.json({
      accessToken: minted.accessToken,
      expiresAt: minted.expiresAt,
      scope: minted.scope,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
