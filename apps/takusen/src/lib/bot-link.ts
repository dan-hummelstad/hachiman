/**
 * The link mailbox of a bot (contract §4 Bots "Device linking"). A new bot device (a new shard, or
 * a bot on a new machine) posts its QR link payload sealed with the bot's deployment key, which
 * only the bot's own devices hold. A running device of the bot opens it and does the QR link of
 * §12.5. Takusen stores the sealed blobs for the life of a link session and cannot open them.
 */
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { bots } from '@/db/schema'
import { requireMe } from '@/lib/api-helpers'
import { ForbiddenError, requireUser } from '@/lib/auth-helpers'
import { redis } from '@/lib/events'

/** As a link session (§12.5): an older request has no session to link. */
export const BOT_LINK_TTL_SECONDS = 600
/** A bot has at most this many requests waiting; a new one drops the oldest. */
export const BOT_LINK_MAX = 20

const key = (botId: string): string => `takusen:bot_link:${botId}`

export interface BotLinkRequest {
  id: string
  blob: string
  createdAt: string
}

export async function postBotLinkRequest(botId: string, blob: string): Promise<BotLinkRequest> {
  const req: BotLinkRequest = { id: randomUUID(), blob, createdAt: new Date().toISOString() }
  await redis()
    .multi()
    .lpush(key(botId), JSON.stringify(req))
    .ltrim(key(botId), 0, BOT_LINK_MAX - 1)
    .expire(key(botId), BOT_LINK_TTL_SECONDS)
    .exec()
  return req
}

/** The requests younger than BOT_LINK_TTL_SECONDS, newest first. */
export async function listBotLinkRequests(botId: string, now = Date.now()): Promise<BotLinkRequest[]> {
  const raw = await redis().lrange(key(botId), 0, BOT_LINK_MAX - 1)
  return raw
    .map((r) => JSON.parse(r) as BotLinkRequest)
    .filter((r) => now - Date.parse(r.createdAt) < BOT_LINK_TTL_SECONDS * 1000)
}

/** The calling bot (the route param must be `@me`), else 403. */
export async function requireBotCaller(param: string): Promise<{ userId: string; ownerId: string }> {
  const session = await requireUser()
  requireMe(param)
  const [row] = await db
    .select({ userId: bots.userId, ownerId: bots.ownerId })
    .from(bots)
    .where(eq(bots.userId, session.user.id))
    .limit(1)
  if (!row) throw new ForbiddenError('Only a bot can call this route')
  return row
}
