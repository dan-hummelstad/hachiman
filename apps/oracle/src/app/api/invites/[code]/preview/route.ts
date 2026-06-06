/**
 * GET /api/invites/[code]/preview — non-consuming peek at an invite.
 *
 * Returns the same `{ joinUri, server }` shape as the redeem endpoint, but
 * does NOT increment useCount. Used by the Hachiman client so a pasted
 * `/i/<code>` link can be parsed + previewed before the user clicks Connect
 * — see apps/hachiman/src/services/JoinUriService.ts.
 *
 * Still rejects revoked / expired / exhausted invites (so the preview can
 * surface the same error the redeem would). Use-count enforcement remains
 * best-effort: anyone who can preview can also build the same signed
 * payload, so the real audience-binding lives in the per-server OIDC token
 * minted at connect time, not in this counter.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import {
  buildJoinUri,
  getInviteByCode,
  InviteExhaustedError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteRevokedError,
} from '@/lib/invite-signing'
import { getServerById } from '@/lib/servers'

interface RouteContext {
  params: Promise<{ code: string }>
}

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { code } = await ctx.params
    const invite = await getInviteByCode(code)
    if (!invite) throw new InviteNotFoundError()
    if (invite.revoked) throw new InviteRevokedError()
    if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
      throw new InviteExpiredError()
    }
    if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
      throw new InviteExhaustedError()
    }

    const server = await getServerById(invite.virtualServerId)
    if (!server) throw new InviteNotFoundError()

    const joinUri = buildJoinUri(server)
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
