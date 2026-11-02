/**
 * Bot account management (docs/gateway-protocol.md §4 Bots): create, list,
 * reset the token, delete. The REST routes under /api/v1/bots and the
 * dashboard page /bots call these. Token format and lookup: lib/bots.ts.
 */
import { randomUUID } from 'node:crypto'

import { Permissions, has } from '@hachiman/client/permissions'
import type { GuildFull, User } from '@hachiman/client/types'
import { and, asc, count, eq, isNull, max } from 'drizzle-orm'
import { z } from 'zod'

import { db, type Tx } from '@/db/client'
import { botTokens, bots, guildMembers, guilds, users } from '@/db/schema'
import { deleteUserIn, publishUserDeleted } from '@/lib/admin-users'
import { ForbiddenError } from '@/lib/auth-helpers'
import { publishToGuild, publishToUser } from '@/lib/events'
import { loadGuildAccess, requirePermission } from '@/lib/guild-access'
import { acceptInvite, createInvite } from '@/lib/invites'
import { ApiError, NotFoundError } from '@/lib/errors'
import { loadGuildFull, loadMember, membershipChanged, membershipTransaction, MembershipTriggers, userColumns } from '@/lib/guilds'
import { revokeUserSessions } from '@/lib/session-revocation'
import { UUID_RE } from '@/lib/ids'
import { toUser } from '@/lib/wire'

import { generateBotToken, hashBotToken, parseBotGrant } from './bots'

export const MAX_BOTS_PER_OWNER = 10

export const botNameSchema = z.string().trim().min(2).max(32)

export interface BotSummary {
  bot: User
  createdAt: string
  /** When the live token was last used (at most one write per minute), or null. */
  lastUsedAt: string | null
}

/** Locks the owner row. Only a user that is not a bot may own bots. */
async function lockOwner(tx: Tx, ownerId: string): Promise<void> {
  const [row] = await tx.select({ bot: users.bot }).from(users).where(eq(users.id, ownerId)).for('update')
  if (!row || row.bot) throw new ForbiddenError()
}

async function insertToken(tx: Tx, botId: string): Promise<string> {
  const token = generateBotToken()
  await tx.insert(botTokens).values({ botId, tokenHash: hashBotToken(token) })
  return token
}

export async function listBots(ownerId: string): Promise<BotSummary[]> {
  const rows = await db
    // One row per bot: the bot token and each device token (one per shard) are live rows, and the
    // newest use of any of them is when the bot last ran.
    .select({ user: userColumns, createdAt: bots.createdAt, lastUsedAt: max(botTokens.lastUsedAt) })
    .from(bots)
    .innerJoin(users, eq(users.id, bots.userId))
    .leftJoin(botTokens, and(eq(botTokens.botId, bots.userId), isNull(botTokens.revokedAt)))
    .where(eq(bots.ownerId, ownerId))
    .groupBy(bots.userId, users.id)
    .orderBy(asc(bots.createdAt), asc(bots.userId))
  return rows.map((r) => ({
    bot: toUser(r.user),
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }))
}

/** Creates the bot user, its `bots` row and its first token. The token is returned only here. */
export async function createBot(ownerId: string, name: string): Promise<{ bot: User; token: string }> {
  const displayName = botNameSchema.parse(name)
  return db.transaction(async (tx) => {
    await lockOwner(tx, ownerId)
    const [{ n }] = await tx.select({ n: count() }).from(bots).where(eq(bots.ownerId, ownerId))
    if (n >= MAX_BOTS_PER_OWNER) throw new ApiError('TooManyBots', 409, `At most ${MAX_BOTS_PER_OWNER} bots per user`)
    const id = randomUUID()
    const [user] = await tx
      .insert(users)
      .values({ id, email: `${id}@bots.invalid`, displayName, name: displayName, bot: true })
      .returning(userColumns)
    await tx.insert(bots).values({ userId: id, ownerId })
    const token = await insertToken(tx, id)
    return { bot: toUser(user), token }
  })
}

/** Locks the `bots` row of `botId` if `ownerId` owns it, else 404. */
async function lockOwnBot(tx: Tx, ownerId: string, botId: string): Promise<void> {
  if (!UUID_RE.test(botId)) throw new NotFoundError('Unknown bot')
  const [row] = await tx
    .select({ id: bots.userId })
    .from(bots)
    .where(and(eq(bots.userId, botId), eq(bots.ownerId, ownerId)))
    .for('update')
  if (!row) throw new NotFoundError('Unknown bot')
}

/** Revokes the live token and makes a new one. The new token is returned only here. */
export async function resetBotToken(ownerId: string, botId: string): Promise<string> {
  return db.transaction(async (tx) => {
    await lockOwnBot(tx, ownerId, botId)
    await tx
      .update(botTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(botTokens.botId, botId), isNull(botTokens.revokedAt)))
    return insertToken(tx, botId)
  })
}

/**
 * For a bot that lost its state directory and its recovery key: the DS half of a password reset
 * (§12.4 "Password reset", as POST /api/admin/users/:id/reset-keys). Every device of the bot is
 * revoked and its master key is superseded, so the next start makes a new identity. The old token
 * stops with its device; the new one is returned only here. Dashboard only: a bearer token alone
 * cannot replace a master key.
 */
export async function resetBotKeys(ownerId: string, botId: string): Promise<string> {
  // One transaction: the keys are never reset without a new token for the owner.
  const token = await membershipTransaction(async (tx) => {
    await lockOwnBot(tx, ownerId, botId)
    await membershipChanged(tx, MembershipTriggers.passwordReset(botId), null)
    await tx
      .update(botTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(botTokens.botId, botId), isNull(botTokens.revokedAt)))
    return insertToken(tx, botId)
  })
  await revokeUserSessions(botId)
  return token
}

/** Deletes the bot user as the admin user delete does (§4 Admin API). The cascades take `bots` and `bot_tokens`. */
export async function deleteBot(ownerId: string, botId: string): Promise<void> {
  const result = await membershipTransaction(async (tx) => {
    await lockOwnBot(tx, ownerId, botId)
    const [target] = await tx.select(userColumns).from(users).where(eq(users.id, botId)).for('update')
    if (!target) throw new NotFoundError('Unknown bot')
    return deleteUserIn(tx, target)
  })
  await publishUserDeleted(result)
}

/** The guilds where `ownerId` may add a bot: MANAGE_GUILD, as on Discord. */
export async function listManageableGuilds(ownerId: string): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .select({ id: guilds.id, name: guilds.name })
    .from(guildMembers)
    .innerJoin(guilds, eq(guilds.id, guildMembers.guildId))
    .where(eq(guildMembers.userId, ownerId))
    .orderBy(asc(guilds.name))
  const out: { id: string; name: string }[] = []
  for (const g of rows) {
    const access = await loadGuildAccess(g.id, ownerId)
    if (has(access.permissions, Permissions.MANAGE_GUILD)) out.push(g)
  }
  return out
}

/**
 * Adds the bot to a guild of the owner, as Discord's bot invite does: the owner needs
 * MANAGE_GUILD there. It is an invite join: a single-use invite of 5 minutes that the bot
 * accepts at once, so the membership, the DS change (§12.18) and the events are those of
 * POST /invites/:code. The bot joins the guild's MLS groups when it next runs.
 */
export async function addBotToGuild(ownerId: string, botId: string, guildId: string): Promise<GuildFull> {
  if (!UUID_RE.test(guildId)) throw new NotFoundError('Unknown guild')
  await db.transaction((tx) => lockOwnBot(tx, ownerId, botId))
  requirePermission((await loadGuildAccess(guildId, ownerId)).permissions, Permissions.MANAGE_GUILD)
  const invite = await createInvite({
    guildId,
    createdBy: ownerId,
    expiresAt: new Date(Date.now() + 5 * 60_000),
    maxUses: 1
  })
  const { joined } = await acceptInvite(invite.code, botId, null)
  const full = await loadGuildFull(guildId, botId)
  if (joined) {
    await publishToGuild(guildId, 'GUILD_MEMBER_ADD', await loadMember(guildId, botId))
    await publishToUser(botId, 'GUILD_CREATE', full)
  }
  return full
}

/** Live device tokens per bot: shards, plus room for devices that are not revoked yet. */
export const MAX_DEVICE_TOKENS = 64

/**
 * Mints a device token (contract §4 Bots "Device tokens"): a new grant for one new device of the
 * bot. Only the owner-issued bot token may mint (`callerGrantId` is the grant of the request), so
 * a device token cannot copy itself. The new device still needs a link to get the bot's keys.
 */
export async function mintDeviceToken(botId: string, callerGrantId: string | null): Promise<string> {
  const tokenId = parseBotGrant(callerGrantId)
  if (!tokenId || !UUID_RE.test(tokenId)) throw new ForbiddenError('Mint device tokens with the bot token')
  return db.transaction(async (tx) => {
    const [caller] = await tx
      .select({ kind: botTokens.kind })
      .from(botTokens)
      .where(and(eq(botTokens.id, tokenId), eq(botTokens.botId, botId), isNull(botTokens.revokedAt)))
      .for('update')
    if (caller?.kind !== 'bot') throw new ForbiddenError('Mint device tokens with the bot token')
    const [{ n }] = await tx
      .select({ n: count() })
      .from(botTokens)
      .where(and(eq(botTokens.botId, botId), eq(botTokens.kind, 'device'), isNull(botTokens.revokedAt)))
    if (n >= MAX_DEVICE_TOKENS) throw new ApiError('TooManyDeviceTokens', 409, 'This bot has too many devices. Revoke old ones.')
    const token = generateBotToken()
    await tx.insert(botTokens).values({ botId, tokenHash: hashBotToken(token), kind: 'device' })
    return token
  })
}
