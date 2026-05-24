/**
 * POST /api/servers/[id]/verify
 *
 * If there's an active verification, return it; otherwise start a new one.
 * Returns the TXT record details the owner should publish.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { requireUser } from '@/lib/auth-helpers'
import { errorResponse } from '@/lib/api-helpers'
import {
  dnsVerificationHostname,
  getActiveVerification,
  startDomainVerification,
} from '@/lib/dns-verify'
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
    const server = await assertOwner(id, session.user.id)

    let verification = await getActiveVerification(id)
    if (!verification) {
      verification = await startDomainVerification(id, server.host)
    }

    return NextResponse.json({
      verificationId: verification.id,
      txtRecord: dnsVerificationHostname(verification.domain),
      txtValue: verification.txtToken,
      verifiedAt: verification.verifiedAt,
      lastCheckedAt: verification.lastCheckedAt,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
