/**
 * The guild soundboard (docs/gateway-protocol.md §4 Soundboard, §12.21). The server stores the
 * name and emoji as plaintext metadata and the clip as an encrypted blob. The file key is only
 * in the envelope: a doc_snapshot envelope of the public_set group, with the sound id as page id.
 */
import { and, asc, count, eq, inArray, isNull, type SQL } from 'drizzle-orm'
import type { GuildSound } from '@hachiman/client/types'
import { z } from 'zod'

import { db, type Tx } from '@/db/client'
import { channels, guilds, guildSounds, mlsGroups, uploads, type GuildSoundRow } from '@/db/schema'
import { ApiError, NotFoundError, UnknownUploadError, ValidationError } from '@/lib/errors'
import { blobKey } from '@/lib/files'
import { toB64 } from '@/lib/mls/bytes'
import { envelopeField } from '@/lib/wire'

export const MAX_SOUND_NAME = 32
export const MAX_SOUND_EMOJI = 32
export const MAX_GUILD_SOUNDS = 48
/**
 * The blob cap. The client caps the clip at 512 KiB and 5 s. The blob of 512 KiB is at most
 * Padmé(512 KiB + 1) + 13 + 16 × 9 bytes (§12.9), which is below this.
 */
export const SOUND_MAX_BLOB_BYTES = 560 * 1024

// No control or bidi control characters, as for a custom status.
const NO_CONTROL = /^[^\p{Cc}‎‏‪-‮⁦-⁩]*$/u

export const createSoundSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(MAX_SOUND_NAME).regex(NO_CONTROL, 'name has control characters'),
  emoji: z.string().trim().min(1).max(MAX_SOUND_EMOJI).regex(NO_CONTROL, 'emoji has control characters').nullable().optional(),
  uploadId: z.string().uuid(),
  channelId: z.string().uuid(),
  envelope: envelopeField,
})
export type CreateSoundBody = z.infer<typeof createSoundSchema>

export function toGuildSound(row: GuildSoundRow, size: number): GuildSound {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    emoji: row.emoji,
    uploadId: row.uploadId,
    key: blobKey(row.uploadId),
    size,
    channelId: row.channelId,
    groupId: toB64(row.groupId),
    epoch: row.epoch,
    senderDevice: row.senderDevice,
    envelope: toB64(row.envelope),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listSounds(guildId: string): Promise<GuildSound[]> {
  const rows = await db
    .select({ sound: guildSounds, size: uploads.size })
    .from(guildSounds)
    .innerJoin(uploads, eq(uploads.id, guildSounds.uploadId))
    .where(eq(guildSounds.guildId, guildId))
    .orderBy(asc(guildSounds.createdAt), asc(guildSounds.id))
  return rows.map((r) => toGuildSound(r.sound, r.size))
}

/**
 * 400 `NotPublicChannel` unless the channel is a text or pages channel of the guild whose current
 * group is the public_set group: every member can then read the envelope.
 */
export async function assertSoundChannel(tx: Tx, guildId: string, channelId: string): Promise<void> {
  const [row] = await tx
    .select({ guildId: channels.guildId, type: channels.type, kind: mlsGroups.kind })
    .from(channels)
    .leftJoin(mlsGroups, eq(mlsGroups.groupId, channels.mlsGroupId))
    .where(eq(channels.id, channelId))
    .limit(1)
  if (!row || row.guildId !== guildId || (row.type !== 'text' && row.type !== 'pages') || row.kind !== 'public_set') {
    throw new ApiError('NotPublicChannel', 400, 'the channel is not a public text or pages channel of the guild')
  }
}

/**
 * 400 when the guild has MAX_GUILD_SOUNDS. The guild row lock orders concurrent creates, so the
 * count cannot pass MAX_GUILD_SOUNDS.
 */
export async function assertSoundRoom(tx: Tx, guildId: string): Promise<void> {
  await tx.select({ id: guilds.id }).from(guilds).where(eq(guilds.id, guildId)).for('update')
  const [row] = await tx.select({ n: count() }).from(guildSounds).where(eq(guildSounds.guildId, guildId))
  if ((row?.n ?? 0) >= MAX_GUILD_SOUNDS) throw new ValidationError(`A guild has at most ${MAX_GUILD_SOUNDS} sounds`)
}

/**
 * Claims an unclaimed encrypted blob of the caller as a sound. Throws UnknownUpload when it is
 * not the caller's, not a blob or already claimed, and 413 when it is above SOUND_MAX_BLOB_BYTES.
 * Returns the blob size.
 */
export async function claimSoundUpload(tx: Tx, uploadId: string, userId: string): Promise<number> {
  const mine: SQL = and(eq(uploads.id, uploadId), eq(uploads.uploaderId, userId), eq(uploads.encrypted, true), isNull(uploads.purpose))!
  const [row] = await tx.select({ size: uploads.size }).from(uploads).where(mine).limit(1)
  if (!row) throw new UnknownUploadError(`Unknown upload ${uploadId}`)
  if (row.size > SOUND_MAX_BLOB_BYTES) throw new ApiError('SoundTooLarge', 413, `a sound blob is at most ${SOUND_MAX_BLOB_BYTES} bytes`)
  const claimed = await tx.update(uploads).set({ purpose: 'sound' }).where(mine).returning({ id: uploads.id })
  if (claimed.length !== 1) throw new UnknownUploadError(`Unknown upload ${uploadId}`)
  return row.size
}

/**
 * Deletes one sound with its upload row (the sound row cascades) and returns the object key.
 * Pass it to deleteObjects after commit. Throws NotFound when the guild has no such sound.
 */
export async function deleteSound(tx: Tx, guildId: string, soundId: string): Promise<string | null> {
  const [sound] = await tx
    .select({ uploadId: guildSounds.uploadId })
    .from(guildSounds)
    .where(and(eq(guildSounds.id, soundId), eq(guildSounds.guildId, guildId)))
    .limit(1)
  if (!sound) throw new NotFoundError('Unknown sound')
  const [row] = await tx.delete(uploads).where(eq(uploads.id, sound.uploadId)).returning({ key: uploads.key })
  return row?.key ?? null
}

/** Guild delete: removes the sound uploads of the guild in `tx` and returns their keys. */
export async function deleteGuildSoundUploads(tx: Tx, guildId: string): Promise<string[]> {
  const rows = await tx
    .delete(uploads)
    .where(
      inArray(
        uploads.id,
        tx.select({ id: guildSounds.uploadId }).from(guildSounds).where(eq(guildSounds.guildId, guildId)),
      ),
    )
    .returning({ key: uploads.key })
  return rows.map((r) => r.key)
}
