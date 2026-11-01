/**
 * POST /api/v1/users/@me/bot/device-tokens → 201 {token}
 *
 * A device token for one new device of the calling bot (contract §4 Bots "Device tokens"). Only
 * the bot token that the owner got may call this: a device token gets 403. Each device (each
 * shard) then has its own grant, so the device binding (§12.12) and a device revocation hold per
 * device.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { bearerGrantId } from '@/lib/auth-helpers'
import { mintDeviceToken } from '@/lib/bot-accounts'
import { requireBotCaller } from '@/lib/bot-link'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { userId } = await requireBotCaller((await ctx.params).id)
    return NextResponse.json({ token: await mintDeviceToken(userId, await bearerGrantId(req)) }, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
