/**
 * GET  /api/v1/guilds/:id/invites — active (non-revoked) invites, permanent
 *      first, then newest first; MANAGE_GUILD.
 * POST /api/v1/guilds/:id/invites { maxAgeSeconds?, maxUses?, acknowledgedPermanent?, record? }
 *      — CREATE_INSTANT_INVITE. Default 24 h, unlimited uses; maxUses 0 means
 *      unlimited. Without ADMINISTRATOR: 1–86400 s, else 403. ADMINISTRATOR:
 *      up to 7 days, or 0 (permanent) with acknowledgedPermanent: true, else 400.
 *      `record` (an invite with history, §12.11.4): ADMINISTRATOR and
 *      X-Hachiman-Device. The record must verify under the device certificate
 *      and match the guild, the caller and the body, else 400.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { invites } from '@/db/schema'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { MissingPermissionsError } from '@/lib/errors'
import { isPrivileged, loadGuildAccess, requirePermission } from '@/lib/guild-access'
import { checkInviteRecord, INVITE_RECORD_MAX_BYTES } from '@/lib/invite-history'
import { assertInviteLimits, MAX_INVITE_AGE_S, MAX_LIMITED_INVITE_AGE_S } from '@/lib/invite-limits'
import { createAdminInvite, createInvite } from '@/lib/invites'
import { b64 } from '@/lib/mls/bytes'
import { getDsModule } from '@/lib/mls/crypto'
import { requireDevice } from '@/lib/mls/device-auth'
import { toInvite } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

const createInviteSchema = z.object({
  maxAgeSeconds: z.number().int().min(0).max(MAX_INVITE_AGE_S).default(MAX_LIMITED_INVITE_AGE_S),
  maxUses: z.number().int().min(0).max(100).default(0),
  acknowledgedPermanent: z.boolean().optional(),
  record: b64(INVITE_RECORD_MAX_BYTES).optional(),
})

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.MANAGE_GUILD)
    const rows = await db
      .select()
      .from(invites)
      .where(and(eq(invites.guildId, id), eq(invites.revoked, false)))
      .orderBy(desc(isNull(invites.expiresAt)), desc(invites.createdAt))
    return NextResponse.json(rows.map(toInvite))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.CREATE_INSTANT_INVITE)
    const body = await parseBody(req, createInviteSchema)
    const isAdmin = isPrivileged(access)
    if (body.record && !isAdmin) throw new MissingPermissionsError('Only an administrator can make an invite with history')
    assertInviteLimits(body, isAdmin)
    const now = new Date()
    let history: { record: Uint8Array; keyId: Uint8Array } | undefined
    if (body.record) {
      const device = await requireDevice(req, session.user.id)
      const view = device.certificate ? (await getDsModule()).verifyInviteRecord(body.record, device.certificate) : null
      const keyId = checkInviteRecord(view, {
        guildId: access.guild.id,
        userId: session.user.id,
        deviceId: device.id,
        maxAgeSeconds: body.maxAgeSeconds,
        maxUses: body.maxUses,
        now,
      })
      history = { record: body.record, keyId }
    }
    const opts = {
      guildId: access.guild.id,
      createdBy: session.user.id,
      expiresAt: body.maxAgeSeconds === 0 ? null : new Date(now.getTime() + body.maxAgeSeconds * 1000),
      maxUses: body.maxUses > 0 ? body.maxUses : null,
    }
    const row = opts.expiresAt === null || history ? await createAdminInvite({ ...opts, history }) : await createInvite(opts)
    return NextResponse.json(toInvite(row))
  } catch (err) {
    return errorResponse(err)
  }
}
