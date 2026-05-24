/**
 * GET /api/servers/mine — list the current user's servers.
 */
import { NextResponse } from 'next/server'

import { requireUser } from '@/lib/auth-helpers'
import { errorResponse } from '@/lib/api-helpers'
import { listServersByOwner } from '@/lib/servers'

export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const servers = await listServersByOwner(session.user.id)
    return NextResponse.json({ servers })
  } catch (err) {
    return errorResponse(err)
  }
}
