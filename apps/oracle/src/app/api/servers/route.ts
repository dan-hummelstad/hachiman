/**
 * POST /api/servers — create a new server for the current user.
 * Returns { server, oidcClientId, oidcClientSecret } (secret shown ONCE).
 */
import { NextResponse, type NextRequest } from 'next/server'

import { requireUser } from '@/lib/auth-helpers'
import { errorResponse } from '@/lib/api-helpers'
import { createServer, createServerSchema } from '@/lib/servers'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const body = await req.json()
    const parsed = createServerSchema.parse(body)
    const result = await createServer({
      ownerUserId: session.user.id,
      ...parsed,
    })
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
