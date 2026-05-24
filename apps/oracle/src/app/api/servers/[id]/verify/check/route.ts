/**
 * POST /api/servers/[id]/verify/check — re-resolves the TXT record.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { requireUser } from '@/lib/auth-helpers'
import { errorResponse } from '@/lib/api-helpers'
import { checkDomainVerification, getActiveVerification } from '@/lib/dns-verify'
import { assertOwner } from '@/lib/servers'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await assertOwner(id, session.user.id)

    const verification = await getActiveVerification(id)
    if (!verification) {
      return NextResponse.json(
        { error: 'NoActiveVerification' },
        { status: 400 },
      )
    }
    const result = await checkDomainVerification(verification.id)
    return NextResponse.json({
      verified: result.verified,
      records: result.records,
      error: result.error,
      lastCheckedAt: result.lastCheckedAt,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
