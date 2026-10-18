/**
 * DMs and group DMs (contract §4 DMs): the participants, the per-viewer
 * channel events, and the group DM edit, add, leave and delete. A group DM channel
 * shows every participant except the viewer, so each event is built per user.
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { GatewayEventName } from '@hachiman/client/types'

import { db, type Tx } from '@/db/client'
import { channels, dmParticipants, guildMembers, users, type ChannelRow } from '@/db/schema'
import { assertNotBlocked } from '@/lib/blocks'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import { publishToUser } from '@/lib/events'
import { getLimits } from '@/lib/files'
import { groupVisibility, membershipChanged, membershipTransaction, MembershipTriggers, userColumns } from '@/lib/guilds'
import { deleteObjects } from '@/lib/storage'
import { claimImage, deleteAttachmentRows } from '@/lib/uploads'
import { toDmChannel, type UserLike } from '@/lib/wire'

type DmEvent = Extract<GatewayEventName, 'CHANNEL_CREATE' | 'CHANNEL_UPDATE' | 'CHANNEL_DELETE'>

/** Participants (as users) for each of `channelIds`. */
export async function participantsOf(channelIds: string[]): Promise<Map<string, UserLike[]>> {
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

/** Publishes `t` to each of `userIds`, with the channel as that user sees it. */
export async function publishDm(channel: ChannelRow, t: DmEvent, userIds: string[]): Promise<void> {
  const [participants, groups] = await Promise.all([participantsOf([channel.id]), groupVisibility([channel.mlsGroupId])])
  const list = participants.get(channel.id) ?? []
  await Promise.all(userIds.map((id) => publishToUser(id, t, toDmChannel(channel, list, id, groups))))
}

/** At most `Limits.maxGroupDmMembers` participants, me included (TAKUSEN_PUBLIC_SET_MAX_MEMBERS). */
export function assertGroupSize(participants: number): void {
  const { maxGroupDmMembers } = getLimits()
  if (participants > maxGroupDmMembers) {
    throw new ValidationError(`A group DM has at most ${maxGroupDmMembers} participants`)
  }
}

/** `me` may message each of `userIds`: a shared guild with each, and no block either way (403 `Blocked`). */
export async function assertCanMessage(me: string, userIds: string[]): Promise<void> {
  const theirs = alias(guildMembers, 'theirs')
  const shared = await db
    .selectDistinct({ userId: theirs.userId })
    .from(guildMembers)
    .innerJoin(theirs, eq(theirs.guildId, guildMembers.guildId))
    .where(and(eq(guildMembers.userId, me), inArray(theirs.userId, userIds)))
  if (shared.length !== userIds.length) {
    throw new MissingPermissionsError('Recipients must share a guild with you')
  }
  await assertNotBlocked(me, userIds)
}

/** Only a group DM has settings, a leave and a delete. A 1:1 DM has none. */
export function requireGroupDm(channel: ChannelRow): void {
  if (channel.type !== 'group_dm') throw new ValidationError('A 1:1 DM has no settings')
}

/** PATCH: any participant renames the group or sets its image (an image upload id, or null). */
export async function updateGroupDm(
  channel: ChannelRow,
  userId: string,
  body: { name?: string | null; icon?: string | null },
): Promise<ChannelRow> {
  return db.transaction(async (tx) => {
    const changes: Partial<ChannelRow> = {}
    if (body.name !== undefined) changes.name = body.name
    if (body.icon !== undefined) changes.icon = body.icon === null ? null : await claimImage(tx, body.icon, userId)
    if (Object.keys(changes).length === 0) return channel
    const [row] = await tx.update(channels).set(changes).where(eq(channels.id, channel.id)).returning()
    return row!
  })
}

/**
 * POST /channels/:id/recipients: any participant adds people. Their devices
 * get MLS Adds; with `historyVisibility` joined they read from now on.
 */
export async function addToGroupDm(channel: ChannelRow, userIds: string[], actorDeviceId: string | null): Promise<void> {
  const added = await membershipTransaction(async (tx) => {
    // The lock orders concurrent adds and leaves, so the size check holds.
    await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, channel.id)).for('update')
    const present = new Set(
      (await tx.select({ userId: dmParticipants.userId }).from(dmParticipants).where(eq(dmParticipants.channelId, channel.id))).map((r) => r.userId),
    )
    const added = [...new Set(userIds)].filter((id) => !present.has(id))
    if (added.length === 0) throw new ValidationError('Everyone is in the group already')
    assertGroupSize(present.size + added.length)
    await tx.insert(dmParticipants).values(added.map((userId) => ({ channelId: channel.id, userId })))
    await membershipChanged(tx, MembershipTriggers.dmParticipantsChanged(channel.id), actorDeviceId)
    return { added, present: [...present] }
  })
  await publishDm(channel, 'CHANNEL_CREATE', added.added)
  await publishDm(channel, 'CHANNEL_UPDATE', added.present)
}

/** The rows of a group DM go: its attachments, its MLS groups (retired) and the channel. Returns the object keys. */
async function deleteGroupDmRows(tx: Tx, channelId: string, actorDeviceId: string | null): Promise<string[]> {
  const keys = await deleteAttachmentRows(tx, { channelIds: [channelId] })
  await membershipChanged(tx, MembershipTriggers.dmDeleted(channelId), actorDeviceId)
  await tx.delete(channels).where(eq(channels.id, channelId))
  return keys
}

/** DELETE /channels/:id: only the owner deletes a group DM, for every participant. */
export async function deleteGroupDm(channel: ChannelRow, userId: string, participantIds: string[], actorDeviceId: string | null): Promise<void> {
  if (channel.ownerId !== userId) throw new MissingPermissionsError('Only the owner can delete the group')
  const keys = await membershipTransaction(async (tx) => {
    await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, channel.id)).for('update')
    return deleteGroupDmRows(tx, channel.id, actorDeviceId)
  })
  await deleteObjects(keys)
  await Promise.all(participantIds.map((id) => publishToUser(id, 'CHANNEL_DELETE', toDmChannel(channel, [], id))))
}

/**
 * DELETE /users/@me/channels/:id: the caller leaves a group DM. Its devices get
 * MLS Removes. An owner who leaves passes the group to the participant with the
 * lowest id. The last one to leave deletes the group.
 */
export async function leaveGroupDm(channel: ChannelRow, userId: string, actorDeviceId: string | null): Promise<void> {
  const { row, remaining, keys } = await membershipTransaction(async (tx) => {
    // The lock orders concurrent leaves, so the last one sees no one left.
    await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, channel.id)).for('update')
    await tx.delete(dmParticipants).where(and(eq(dmParticipants.channelId, channel.id), eq(dmParticipants.userId, userId)))
    const remaining = (
      await tx.select({ userId: dmParticipants.userId }).from(dmParticipants).where(eq(dmParticipants.channelId, channel.id)).orderBy(asc(dmParticipants.userId))
    ).map((r) => r.userId)
    if (remaining.length === 0) return { row: channel, remaining, keys: await deleteGroupDmRows(tx, channel.id, actorDeviceId) }
    const [row] =
      channel.ownerId === userId
        ? await tx.update(channels).set({ ownerId: remaining[0] }).where(eq(channels.id, channel.id)).returning()
        : [channel]
    await membershipChanged(tx, MembershipTriggers.dmParticipantsChanged(channel.id), actorDeviceId)
    return { row: row!, remaining, keys: [] as string[] }
  })
  await deleteObjects(keys)
  await publishToUser(userId, 'CHANNEL_DELETE', toDmChannel(row, [], userId))
  if (remaining.length > 0) await publishDm(row, 'CHANNEL_UPDATE', remaining)
}
