/**
 * POST /api/servers/[id]/invites — create an invite.
 * Body: { expiresInDays?, maxUses? }
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { requireUser } from '@/lib/auth-helpers'
import { errorResponse } from '@/lib/api-helpers'
import { createInvite } from '@/lib/invite-signing'
import { assertOwner } from '@/lib/servers'

const createInviteSchema = z.object({
  expiresInDays: z
    .number()
    .int()
    .min(1, 'expiresInDays must be >= 1')
    .max(365, 'expiresInDays must be <= 365')
    .optional()
    .nullable(),
  maxUses: z
    .number()
    .int()
    .min(1, 'maxUses must be >= 1')
    .max(10000, 'maxUses must be <= 10000')
    .optional()
    .nullable(),
})

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await assertOwner(id, session.user.id)
    const body = await req.json().catch(() => ({}))
    const parsed = createInviteSchema.parse(body)

    const expiresAt = parsed.expiresInDays
      ? new Date(Date.now() + parsed.expiresInDays * 24 * 60 * 60 * 1000)
      : null

    const invite = await createInvite({
      serverId: id,
      createdByUserId: session.user.id,
      expiresAt,
      maxUses: parsed.maxUses ?? null,
    })

    const origin = req.nextUrl.origin
    return NextResponse.json(
      {
        code: invite.code,
        url: `${origin}/i/${invite.code}`,
        invite,
      },
      { status: 201 },
    )
  } catch (err) {
    return errorResponse(err)
  }
}
