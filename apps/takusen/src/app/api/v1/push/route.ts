/**
 * GET    /api/v1/push → {vapidPublicKey}: the `applicationServerKey` of a browser subscription.
 * PUT    /api/v1/push {kind: 'apns', token, sandbox} | {kind: 'webpush', endpoint, p256dh, auth},
 *        each with {pushKey, pushKeySig, kinds, quiet} + X-Hachiman-Device → 204. The push target
 *        of the device; it replaces the previous one.
 * PATCH  /api/v1/push {kinds, quiet} + X-Hachiman-Device → 204. The filters only.
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
import { NotFoundError } from '@/lib/errors'
import { requireDevice } from '@/lib/mls/device-auth'
import { isWebPushEndpoint, vapidPublicKey } from '@/lib/push'

const b64url = (min: number, max: number) => z.string().min(min).max(max).regex(/^[A-Za-z0-9_-]+$/)

const filters = {
  kinds: z.array(z.enum(['dm', 'mention'])).max(2).transform((k) => [...new Set(k)]),
  quiet: z.array(z.string().uuid()).max(1000),
}

/** A 65-byte P-256 point is 87 base64url characters; an Ed25519 signature is 86. */
const keyFields = { pushKey: b64url(87, 87), pushKeySig: b64url(86, 86), ...filters }

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('apns'), token: z.string().regex(/^[0-9a-f]{64,200}$/i), sandbox: z.boolean(), ...keyFields }).strict(),
  z
    .object({
      kind: z.literal('webpush'),
      endpoint: z.string().max(2048).refine(isWebPushEndpoint, 'not a known push service'),
      p256dh: b64url(87, 87),
      auth: b64url(16, 32),
      ...keyFields,
    })
    .strict(),
])

const filterSchema = z.object(filters).strict()

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
    // Senders check pushKeySig against the leaf of the device (§12.22); Takusen stores it as given.
    const row = {
      kind: body.kind,
      token,
      sandbox: body.kind === 'apns' && body.sandbox,
      p256dh: body.kind === 'webpush' ? body.p256dh : null,
      auth: body.kind === 'webpush' ? body.auth : null,
      pushKey: body.pushKey,
      pushKeySig: body.pushKeySig,
      kinds: body.kinds,
      quiet: body.quiet,
    }
    await db.transaction(async (tx) => {
      // One install, one token: a row of an earlier device of this install would push twice.
      await tx.delete(pushTargets).where(and(eq(pushTargets.token, token), ne(pushTargets.deviceId, device.id)))
      await tx
        .insert(pushTargets)
        .values({ deviceId: device.id, userId: session.user.id, ...row })
        .onConflictDoUpdate({ target: pushTargets.deviceId, set: row })
    })
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const device = await requireDevice(req, session.user.id)
    const body = await parseBody(req, filterSchema)
    const updated = await db.update(pushTargets).set(body).where(eq(pushTargets.deviceId, device.id)).returning({ id: pushTargets.deviceId })
    if (updated.length === 0) throw new NotFoundError('No push target')
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
