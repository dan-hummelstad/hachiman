/**
 * Poke (docs/gateway-protocol.md §4 Poke): POST /users/:id/poke publishes POKE { user } to the
 * target's sessions. It carries no content, so it has no envelope.
 */
import { and, eq, ne } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { User } from '@hachiman/client/types'

import { db } from '@/db/client'
import { dmParticipants, guildMembers } from '@/db/schema'
import { hasBlockBetween } from '@/lib/blocks'
import { ApiError, NotFoundError, ValidationError } from '@/lib/errors'
import { publishToUser } from '@/lib/events'
import { getUserById } from '@/lib/guilds'
import { redisRateLimiter, type RateLimiter } from '@/lib/mls/context'
import { toUser } from '@/lib/wire'

export const PokeLimits = {
  pair: { bucket: 'poke', limit: 1, windowSec: 10 },
  sender: { bucket: 'pokes', limit: 10, windowSec: 60 },
}

export interface PokeDeps {
  /** The sender as the target sees it. Null for an unknown user. */
  user(id: string): Promise<User | null>
  /** True when the two users are members of one guild, or participants of one DM or group DM. */
  sharesSpace(a: string, b: string): Promise<boolean>
  blocked(a: string, b: string): Promise<boolean>
  rate: RateLimiter
  publish(targetId: string, user: User): Promise<void>
}

/**
 * Throws 400 for yourself, 404 for an unknown user or one without a shared guild or DM (the
 * same answer, so a poke does not probe for users), 403 Blocked for a block in either direction,
 * and 429 RateLimited.
 */
export async function pokeWith(deps: PokeDeps, senderId: string, targetId: string): Promise<void> {
  if (senderId === targetId) throw new ValidationError('You cannot poke yourself')
  const [sender, target] = await Promise.all([deps.user(senderId), deps.user(targetId)])
  if (!sender || !target || !(await deps.sharesSpace(senderId, targetId))) throw new NotFoundError('Unknown user')
  if (await deps.blocked(senderId, targetId)) throw new ApiError('Blocked', 403, 'You cannot poke this user')
  const { pair, sender: perSender } = PokeLimits
  await deps.rate.hit(perSender.bucket, senderId, perSender.limit, perSender.windowSec)
  await deps.rate.hit(pair.bucket, `${senderId}:${targetId}`, pair.limit, pair.windowSec)
  await deps.publish(targetId, sender)
}

async function sharesSpace(a: string, b: string): Promise<boolean> {
  const other = alias(guildMembers, 'other_member')
  const [guild] = await db
    .select({ id: guildMembers.guildId })
    .from(guildMembers)
    .innerJoin(other, and(eq(other.guildId, guildMembers.guildId), eq(other.userId, b)))
    .where(eq(guildMembers.userId, a))
    .limit(1)
  if (guild) return true
  const otherDm = alias(dmParticipants, 'other_participant')
  const [dm] = await db
    .select({ id: dmParticipants.channelId })
    .from(dmParticipants)
    .innerJoin(otherDm, and(eq(otherDm.channelId, dmParticipants.channelId), eq(otherDm.userId, b), ne(otherDm.userId, a)))
    .where(eq(dmParticipants.userId, a))
    .limit(1)
  return dm !== undefined
}

export const pokeDeps: PokeDeps = {
  async user(id) {
    const row = await getUserById(id)
    return row && toUser(row)
  },
  sharesSpace,
  blocked: (a, b) => hasBlockBetween(a, [b]),
  rate: redisRateLimiter,
  publish: (targetId, user) => publishToUser(targetId, 'POKE', { user }),
}
