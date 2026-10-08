/**
 * Custom guild emojis (docs/gateway-protocol.md §4 Emojis). The image is a
 * plaintext upload, as a guild icon is. Messages name an emoji as
 * `<:name:id>` inside the envelope, so the server never learns which
 * messages use one.
 */
import { and, asc, count, eq, inArray, isNull, lte } from 'drizzle-orm'
import { EMOJI_IMAGE_TYPES, EMOJI_NAME_RE, MAX_EMOJI_BYTES, MAX_GUILD_EMOJIS } from '@hachiman/client/files'
import type { GuildEmoji } from '@hachiman/client/types'
import { z } from 'zod'

import { db, type Database, type Tx } from '@/db/client'
import { guildEmojis, guilds, uploads, type GuildEmojiRow, type UploadRow } from '@/db/schema'
import { ApiError, ConflictError, InvalidImageError, isUniqueViolation, NotFoundError, UnknownUploadError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'

const name = z.string().regex(EMOJI_NAME_RE, 'name must be 2 to 32 characters of a-z, 0-9 and _')

export const createEmojiSchema = z.object({ name, uploadId: z.string().uuid() })
export const renameEmojiSchema = z.object({ name })

export function toGuildEmoji(row: GuildEmojiRow, key: string): GuildEmoji {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    key,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listEmojis(guildId: string, executor: Database | Tx = db): Promise<GuildEmoji[]> {
  const rows = await executor
    .select({ emoji: guildEmojis, key: uploads.key })
    .from(guildEmojis)
    .innerJoin(uploads, eq(uploads.id, guildEmojis.uploadId))
    .where(eq(guildEmojis.guildId, guildId))
    .orderBy(asc(guildEmojis.createdAt), asc(guildEmojis.id))
  return rows.map((r) => toGuildEmoji(r.emoji, r.key))
}

type EmojiClaimView = Pick<UploadRow, 'uploaderId' | 'purpose' | 'encrypted' | 'contentType' | 'size'>

/**
 * The rule of the emoji claim: an unclaimed plaintext upload of the caller,
 * PNG, GIF or WebP, at most MAX_EMOJI_BYTES. Returns the error to throw, or null.
 */
export function emojiClaimError(row: EmojiClaimView | null, userId: string): Error | null {
  if (!row || row.uploaderId !== userId || row.purpose !== null || row.encrypted) return new UnknownUploadError()
  if (!(EMOJI_IMAGE_TYPES as readonly string[]).includes(row.contentType)) {
    return new InvalidImageError(`Emoji must be one of ${EMOJI_IMAGE_TYPES.join(', ')}`)
  }
  if (row.size > MAX_EMOJI_BYTES) return new InvalidImageError(`Emoji must be at most ${MAX_EMOJI_BYTES} bytes`)
  return null
}

async function claimEmojiImage(tx: Tx, uploadId: string, userId: string): Promise<string> {
  const mine = and(eq(uploads.id, uploadId), eq(uploads.uploaderId, userId))
  // The SQL form of emojiClaimError: keep the two in step.
  const [claimed] = await tx
    .update(uploads)
    .set({ purpose: 'emoji' })
    .where(
      and(
        mine,
        isNull(uploads.purpose),
        eq(uploads.encrypted, false),
        inArray(uploads.contentType, [...EMOJI_IMAGE_TYPES]),
        lte(uploads.size, MAX_EMOJI_BYTES),
      ),
    )
    .returning({ key: uploads.key })
  if (claimed) return claimed.key
  const [row] = await tx
    .select({
      uploaderId: uploads.uploaderId,
      purpose: uploads.purpose,
      encrypted: uploads.encrypted,
      contentType: uploads.contentType,
      size: uploads.size,
    })
    .from(uploads)
    .where(mine)
    .limit(1)
  throw emojiClaimError(row ?? null, userId) ?? new UnknownUploadError()
}

const nameTaken = () => new ConflictError('An emoji with this name exists in the guild')

/**
 * Creates an emoji. The guild row lock orders concurrent creates, so the
 * count cannot pass MAX_GUILD_EMOJIS. Returns the new emoji and the full list.
 */
export async function createEmoji(
  guildId: string,
  userId: string,
  body: z.infer<typeof createEmojiSchema>,
): Promise<{ emoji: GuildEmoji; emojis: GuildEmoji[] }> {
  try {
    return await db.transaction(async (tx) => {
      await tx.select({ id: guilds.id }).from(guilds).where(eq(guilds.id, guildId)).for('update')
      const [n] = await tx.select({ n: count() }).from(guildEmojis).where(eq(guildEmojis.guildId, guildId))
      if ((n?.n ?? 0) >= MAX_GUILD_EMOJIS) {
        throw new ApiError('TooManyEmojis', 400, `A guild has at most ${MAX_GUILD_EMOJIS} emojis`)
      }
      const key = await claimEmojiImage(tx, body.uploadId, userId)
      const [row] = await tx
        .insert(guildEmojis)
        .values({ guildId, name: body.name, uploadId: body.uploadId, createdBy: userId })
        .returning()
      return { emoji: toGuildEmoji(row!, key), emojis: await listEmojis(guildId, tx) }
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken()
    throw err
  }
}

async function loadEmoji(tx: Tx, guildId: string, emojiId: string): Promise<GuildEmojiRow> {
  const [row] = await tx
    .select()
    .from(guildEmojis)
    .where(and(eq(guildEmojis.id, emojiId), eq(guildEmojis.guildId, guildId)))
    .for('update')
    .limit(1)
  if (!row) throw new NotFoundError('Unknown emoji')
  return row
}

export async function renameEmoji(
  guildId: string,
  emojiId: string,
  newName: string,
): Promise<{ emoji: GuildEmoji; emojis: GuildEmoji[] }> {
  try {
    return await db.transaction(async (tx) => {
      await loadEmoji(tx, guildId, emojiId)
      await tx.update(guildEmojis).set({ name: newName }).where(eq(guildEmojis.id, emojiId))
      const emojis = await listEmojis(guildId, tx)
      return { emoji: emojis.find((e) => e.id === emojiId)!, emojis }
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken()
    throw err
  }
}

/** Deletes the emoji and its upload row. Returns the object key to delete after commit, and the list. */
export async function deleteEmoji(guildId: string, emojiId: string): Promise<{ key: string | null; emojis: GuildEmoji[] }> {
  return db.transaction(async (tx) => {
    const row = await loadEmoji(tx, guildId, emojiId)
    // The upload delete cascades to the emoji row.
    const [gone] = await tx.delete(uploads).where(eq(uploads.id, row.uploadId)).returning({ key: uploads.key })
    return { key: gone?.key ?? null, emojis: await listEmojis(guildId, tx) }
  })
}

/** Guild delete: removes the emoji uploads of the guild in `tx` and returns their keys. */
export async function deleteGuildEmojiUploads(tx: Tx, guildId: string): Promise<string[]> {
  const rows = await tx
    .delete(uploads)
    .where(
      inArray(
        uploads.id,
        tx.select({ id: guildEmojis.uploadId }).from(guildEmojis).where(eq(guildEmojis.guildId, guildId)),
      ),
    )
    .returning({ key: uploads.key })
  return rows.map((r) => r.key)
}

export async function publishEmojis(guildId: string, emojis: GuildEmoji[]): Promise<void> {
  await publishToGuild(guildId, 'GUILD_EMOJIS_UPDATE', { guildId, emojis })
}
