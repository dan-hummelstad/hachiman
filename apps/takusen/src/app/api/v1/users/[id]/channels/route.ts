/**
 * GET  /api/v1/users/@me/channels — the caller's DMs and group DMs.
 * POST /api/v1/users/@me/channels { recipientIds } — open a DM (1 recipient,
 *      reuses an existing one) or create a group DM (2 or more recipients, at
 *      most TAKUSEN_PUBLIC_SET_MAX_MEMBERS participants, the guild channel
 *      size). Every recipient must share a guild with the caller.
 *      A new DM gets its dm group in the same transaction (`dm_created`, §12.18).
 *      A block between the caller and any recipient gives 403 `Blocked`.
 */
import { and, count, eq, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { channels, dmParticipants, guildMembers, users } from '@/db/schema'
import { errorResponse, parseBody, requireMe } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import { assertNotBlocked } from '@/lib/blocks'
import { publishToUser } from '@/lib/events'
import { getLimits } from '@/lib/files'
import { actorDeviceId } from '@/lib/guild-access'
import { groupVisibility, membershipChanged, membershipTransaction, MembershipTriggers, userColumns } from '@/lib/guilds'
import { toDmChannel, type UserLike } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

const openDmSchema = z.object({
  recipientIds: z.array(z.string().uuid()).min(1),
})

/** Participants (as users) for each of `channelIds`. */
async function participantsOf(channelIds: string[]): Promise<Map<string, UserLike[]>> {
  const rows =
    channelIds.length === 0
      ? []
      : await db
          .select({ channelId: dmParticipants.channelId, user: userColumns })
          .from(dmParticipants)
          .innerJoin(users, eq(users.id, dmParticipants.userId))
          .where(inArray(dmParticipants.channelId, channelIds))
  const out = new Map<string, UserLike[]>()
  for (const r of rows) out.set(r.channelId, [...(out.get(r.channelId) ?? []), r.user])
  return out
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    requireMe((await ctx.params).id)
    const me = session.user.id
    const rows = await db
      .select({ channel: channels })
      .from(dmParticipants)
      .innerJoin(channels, eq(channels.id, dmParticipants.channelId))
      .where(eq(dmParticipants.userId, me))
    const [participants, groups] = await Promise.all([
      participantsOf(rows.map((r) => r.channel.id)),
      groupVisibility(rows.map((r) => r.channel.mlsGroupId)),
    ])
    return NextResponse.json(
      rows.map(({ channel }) => toDmChannel(channel, participants.get(channel.id) ?? [], me, groups)),
    )
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    requireMe((await ctx.params).id)
    const me = session.user.id
    const { recipientIds: raw } = await parseBody(req, openDmSchema)
    const recipientIds = [...new Set(raw)].filter((id) => id !== me)
    if (recipientIds.length === 0) throw new ValidationError('A DM needs at least one other user')
    const { maxGroupDmMembers } = getLimits()
    if (recipientIds.length + 1 > maxGroupDmMembers) {
      throw new ValidationError(`A group DM has at most ${maxGroupDmMembers} participants`)
    }

    // Recipients must share at least one guild with the caller.
    const theirs = alias(guildMembers, 'theirs')
    const shared = await db
      .selectDistinct({ userId: theirs.userId })
      .from(guildMembers)
      .innerJoin(theirs, eq(theirs.guildId, guildMembers.guildId))
      .where(and(eq(guildMembers.userId, me), inArray(theirs.userId, recipientIds)))
    if (shared.length !== recipientIds.length) {
      throw new MissingPermissionsError('Recipients must share a guild with you')
    }
    await assertNotBlocked(me, recipientIds)

    const participantIds = [me, ...recipientIds]
    const actor = await actorDeviceId(req, me)
    const { channel, created } = await membershipTransaction(async (tx) => {
      if (recipientIds.length === 1) {
        // Serialise concurrent opens of the same pair so only one DM is created.
        const pairKey = [...participantIds].sort().join(':')
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${pairKey}))`)
        const [existing] = await tx
          .select({ channel: channels })
          .from(channels)
          .innerJoin(dmParticipants, eq(dmParticipants.channelId, channels.id))
          .where(and(eq(channels.type, 'dm'), inArray(dmParticipants.userId, participantIds)))
          .groupBy(channels.id)
          .having(eq(count(), 2))
        if (existing) return { channel: existing.channel, created: false }
      }
      const [row] = await tx
        .insert(channels)
        .values(
          recipientIds.length === 1
            ? { type: 'dm' }
            : { type: 'group_dm', ownerId: me },
        )
        .returning()
      await tx
        .insert(dmParticipants)
        .values(participantIds.map((userId) => ({ channelId: row!.id, userId })))
      await membershipChanged(tx, MembershipTriggers.dmCreated(row!.id), actor)
      // The DS sets mls_group_id in this transaction.
      const [withGroup] = await tx.select().from(channels).where(eq(channels.id, row!.id))
      return { channel: withGroup!, created: true }
    })

    const participants = (await participantsOf([channel.id])).get(channel.id) ?? []
    const groups = await groupVisibility([channel.mlsGroupId])
    if (created) {
      await Promise.all(
        participantIds.map((id) =>
          publishToUser(id, 'CHANNEL_CREATE', toDmChannel(channel, participants, id, groups)),
        ),
      )
    }
    return NextResponse.json(toDmChannel(channel, participants, me, groups))
  } catch (err) {
    return errorResponse(err)
  }
}
