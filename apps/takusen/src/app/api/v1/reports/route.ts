/**
 * POST /api/v1/reports { messageId, content, frankingKey, reason } +
 * X-Hachiman-Device — `{ id, verified }` (201). The reporter must see the
 * channel of the message. 10 reports per hour per user (§12.12, §12.16).
 */
import { eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { messageReports, messages } from '@/db/schema'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { NotFoundError } from '@/lib/errors'
import { loadChannelAccess } from '@/lib/guild-access'
import { redisRateLimiter } from '@/lib/mls/context'
import { getDsModule } from '@/lib/mls/crypto'
import { requireDevice } from '@/lib/mls/device-auth'

import { openReport, REPORT_RATE, reportSchema } from './report'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const userId = session.user.id
    await requireDevice(req, userId)
    const body = await parseBody(req, reportSchema)
    await redisRateLimiter.hit(REPORT_RATE.bucket, userId, REPORT_RATE.limit, REPORT_RATE.windowSec)

    const [message] = await db
      .select({ id: messages.id, channelId: messages.channelId, clientMsgId: messages.clientMsgId, frankingTag: messages.frankingTag })
      .from(messages)
      .where(eq(messages.id, body.messageId))
      .limit(1)
    if (!message) throw new NotFoundError('Unknown message')
    await loadChannelAccess(message.channelId, userId)

    const report = openReport(await getDsModule(), message, userId, body)
    const [row] = await db.insert(messageReports).values(report).returning({ id: messageReports.id })
    return NextResponse.json({ id: row!.id, verified: report.verified }, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
