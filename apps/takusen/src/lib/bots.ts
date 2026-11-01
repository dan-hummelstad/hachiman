/**
 * Bot API tokens (docs/gateway-protocol.md §4 Bots).
 *
 * A bot token is `hbot_` + base64url(server origin) + `.h1.` + base64url(32
 * random bytes): the token names its server, so a bot needs nothing but the
 * token. The secret is the last part: discord.js masks every part after the
 * second dot when it logs a token. Takusen keeps only the hex SHA-256 of the
 * whole token in `bot_tokens`. Tokens of the first form (`hbot_` + 43
 * characters, no origin) stay valid. `findAccessToken` (auth-helpers) resolves a
 * bot token to the same fields as an OIDC access token: `accountId` is the
 * bot user, `grantId` is `bot:<tokenId>`. Thus the device binding (§12.12)
 * keys a bot device by its token, as it keys a user device by its OIDC grant.
 *
 * The account management (create, list, reset, delete) is in bot-accounts.ts.
 */
import { createHash, randomBytes } from 'node:crypto'

import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'

import { db } from '@/db/client'
import { botTokens, bots, users } from '@/db/schema'

export const BOT_TOKEN_PREFIX = 'hbot_'
const BOT_TOKEN_RE = /^hbot_(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{4,512}\.h1\.[A-Za-z0-9_-]{43})$/
const BOT_GRANT_PREFIX = 'bot:'
/** The `exp` of a resolved bot token. A bot token has no expiry: each request resolves it again. */
const BOT_TOKEN_EXP_SECONDS = 3600
/** `last_used_at` is written at most once per this interval. */
const TOUCH_INTERVAL_MS = 60_000

/** The public origin of this Takusen (`NEXTAUTH_URL`), which a new token names. */
export function botServerOrigin(): string {
  try {
    return new URL(process.env.NEXTAUTH_URL ?? 'http://localhost:3000').origin
  } catch {
    return 'http://localhost:3000'
  }
}

export function generateBotToken(origin: string = botServerOrigin()): string {
  return `${BOT_TOKEN_PREFIX}${Buffer.from(origin, 'utf8').toString('base64url')}.h1.${randomBytes(32).toString('base64url')}`
}

/** The server origin that a token names, or null (a token of the first form). */
export function botTokenOrigin(token: string): string | null {
  const m = /^hbot_([A-Za-z0-9_-]+)\.h1\./.exec(token)
  return m?.[1] ? Buffer.from(m[1], 'base64url').toString('utf8') : null
}

/** The hex SHA-256 that `bot_tokens.token_hash` stores. */
export function hashBotToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function isBotToken(token: string): boolean {
  return BOT_TOKEN_RE.test(token)
}

export function botGrantId(tokenId: string): string {
  return BOT_GRANT_PREFIX + tokenId
}

export function isBotGrant(grantId: string): boolean {
  return grantId.startsWith(BOT_GRANT_PREFIX)
}

/**
 * The token of an `Authorization` header. `Bearer <token>` carries an OIDC
 * access token or a bot token. `Bot <token>` (the Discord scheme) carries only
 * a bot token.
 */
export function parseAuthorization(header: string | null): { token: string; bot: boolean } | null {
  if (!header) return null
  const match = /^(bearer|bot)\s+(\S+)$/i.exec(header.trim())
  if (!match) return null
  const token = match[2]
  const bot = token.startsWith(BOT_TOKEN_PREFIX)
  if (match[1].toLowerCase() === 'bot' && !bot) return null
  return { token, bot }
}

/** The fields of an OIDC access token that the auth seam reads. */
export interface BotAccessToken {
  accountId: string
  grantId: string
  /** Seconds since the epoch. */
  exp: number
}

export interface LiveBotToken {
  tokenId: string
  botUserId: string
  lastUsedAt: Date | null
}

/** The storage seam of the token lookup. */
export interface BotTokenStore {
  /** The token with this hash that is not revoked, of a bot whose user row exists. */
  findLive(tokenHash: string): Promise<LiveBotToken | null>
  /** Sets `last_used_at` to `now` if it is older than `before`. */
  touch(tokenId: string, now: Date, before: Date): Promise<void>
}

export async function resolveBotTokenWith(store: BotTokenStore, token: string, now = new Date()): Promise<BotAccessToken | null> {
  if (!isBotToken(token)) return null
  const live = await store.findLive(hashBotToken(token))
  if (!live) return null
  if (!live.lastUsedAt || now.getTime() - live.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
    store.touch(live.tokenId, now, new Date(now.getTime() - TOUCH_INTERVAL_MS)).catch((err) => {
      console.error('[bots] last_used_at update failed', err)
    })
  }
  return {
    accountId: live.botUserId,
    grantId: botGrantId(live.tokenId),
    exp: Math.floor(now.getTime() / 1000) + BOT_TOKEN_EXP_SECONDS,
  }
}

export const drizzleBotTokenStore: BotTokenStore = {
  async findLive(tokenHash) {
    const [row] = await db
      .select({ tokenId: botTokens.id, botUserId: bots.userId, lastUsedAt: botTokens.lastUsedAt })
      .from(botTokens)
      .innerJoin(bots, eq(bots.userId, botTokens.botId))
      .innerJoin(users, and(eq(users.id, bots.userId), eq(users.bot, true)))
      .where(and(eq(botTokens.tokenHash, tokenHash), isNull(botTokens.revokedAt)))
      .limit(1)
    return row ?? null
  },
  async touch(tokenId, now, before) {
    await db
      .update(botTokens)
      .set({ lastUsedAt: now })
      .where(and(eq(botTokens.id, tokenId), or(isNull(botTokens.lastUsedAt), lt(botTokens.lastUsedAt, before))))
  },
}

export function resolveBotToken(token: string): Promise<BotAccessToken | null> {
  return resolveBotTokenWith(drizzleBotTokenStore, token)
}

/**
 * Revokes the bot tokens of `bot:<tokenId>` grants. Device revocation calls it
 * for the grants bound to a revoked device (§12.12), as it deletes the OIDC
 * rows of a user grant. Other grant ids are ignored.
 */
export async function revokeBotGrants(grantIds: readonly string[]): Promise<void> {
  const ids = grantIds.filter(isBotGrant).map((g) => g.slice(BOT_GRANT_PREFIX.length))
  if (ids.length === 0) return
  await db
    .update(botTokens)
    .set({ revokedAt: new Date() })
    .where(and(inArray(botTokens.id, ids), isNull(botTokens.revokedAt)))
}
