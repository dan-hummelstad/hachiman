/**
 * GET    /api/v1/push → {vapidPublicKey}: the `applicationServerKey` of a browser subscription.
 * PUT    /api/v1/push {kind: 'apns', token, sandbox} | {kind: 'webpush', endpoint} +
 *        X-Hachiman-Device → 204. The push target of the device; it replaces the previous one.
 * DELETE /api/v1/push + X-Hachiman-Device → 204. The device gets no more push.
 * Contract §4 Push.
 */
import { and, eq, ne } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { pushTargets } from '@/db/schema'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { requireDevice } from '@/lib/mls/device-auth'
import { isWebPushEndpoint, vapidPublicKey } from '@/lib/push'

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('apns'), token: z.string().regex(/^[0-9a-f]{64,200}$/i), sandbox: z.boolean() }).strict(),
  z
    .object({ kind: z.literal('webpush'), endpoint: z.string().max(2048).refine(isWebPushEndpoint, 'not a known push service') })
    .strict(),
])

export async function GET(): Promise<NextResponse> {
  try {
    await requireUser()
    return NextResponse.json({ vapidPublicKey: vapidPublicKey() })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const device = await requireDevice(req, session.user.id)
    const body = await parseBody(req, targetSchema)
    const token = body.kind === 'apns' ? body.token.toLowerCase() : body.endpoint
    const sandbox = body.kind === 'apns' && body.sandbox
    await db.transaction(async (tx) => {
      // One install, one token: a row of an earlier device of this install would push twice.
      await tx.delete(pushTargets).where(and(eq(pushTargets.token, token), ne(pushTargets.deviceId, device.id)))
      await tx
        .insert(pushTargets)
        .values({ deviceId: device.id, userId: session.user.id, kind: body.kind, token, sandbox })
        .onConflictDoUpdate({ target: pushTargets.deviceId, set: { kind: body.kind, token, sandbox } })
    })
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const device = await requireDevice(req, session.user.id)
    await db.delete(pushTargets).where(eq(pushTargets.deviceId, device.id))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
