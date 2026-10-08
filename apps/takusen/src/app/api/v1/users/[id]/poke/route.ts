/**
 * POST /api/v1/users/:id/poke — publishes POKE { user } to the target's sessions only (§4 Poke).
 * The users must share a guild or a DM, and no block may exist between them. 204.
 */
import { type NextRequest, type NextResponse } from 'next/server'

import { errorResponse, noContent } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { assertId } from '@/lib/ids'
import { pokeDeps, pokeWith } from '@/lib/poke'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    assertId(id, 'user')
    await pokeWith(pokeDeps, session.user.id, id)
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
