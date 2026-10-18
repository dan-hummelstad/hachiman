/**
 * DMs and group DMs (contract §4 DMs): the participants, the per-viewer
 * channel events, and the group DM edit, leave and delete. A group DM channel
 * shows every participant except the viewer, so each event is built per user.
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { GatewayEventName } from '@hachiman/client/types'

import { db, type Tx } from '@/db/client'
import { channels, dmParticipants, users, type ChannelRow } from '@/db/schema'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import { publishToUser } from '@/lib/events'
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
    await membershipChanged(tx, MembershipTriggers.dmParticipantRemoved(channel.id), actorDeviceId)
    return { row: row!, remaining, keys: [] as string[] }
  })
  await deleteObjects(keys)
  await publishToUser(userId, 'CHANNEL_DELETE', toDmChannel(row, [], userId))
  if (remaining.length > 0) await publishDm(row, 'CHANNEL_UPDATE', remaining)
}
