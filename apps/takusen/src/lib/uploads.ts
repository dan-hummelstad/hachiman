/**
 * Upload claims and attachment loading (docs/gateway-protocol.md §4 Files).
 * The first claim sets `uploads.purpose`; each claim is one conditional UPDATE,
 * so of two concurrent claims with different purposes only one wins.
 *
 * A message claims only encrypted blobs (`?kind=blob`). An avatar, icon or
 * banner claims only plaintext profile images (`?filename=`).
 */
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { PROFILE_IMAGE_TYPES } from '@hachiman/client/files'
import type { Attachment } from '@hachiman/client/types'

import { db, type Tx } from '@/db/client'
import { channels, guilds, messages, uploads, type UploadRow } from '@/db/schema'
import { InvalidImageError, UnknownUploadError, ValidationError } from '@/lib/errors'
import { toAttachment } from '@/lib/files'
import { MESSAGE_MAX_UPLOAD_IDS } from '@/lib/wire'

type ClaimView = Pick<UploadRow, 'uploaderId' | 'purpose' | 'encrypted' | 'contentType'>

/** The rule of the message claim: an unclaimed encrypted blob of the caller. */
export function messageClaimable(row: ClaimView, userId: string): boolean {
  return row.uploaderId === userId && row.purpose === null && row.encrypted
}

/**
 * The rule of the image claim: an unclaimed or image upload of the caller,
 * not encrypted, with a profile image type. Returns the error to throw, or null.
 */
export function imageClaimError(row: ClaimView | null, userId: string): UnknownUploadError | InvalidImageError | null {
  if (!row || row.uploaderId !== userId || row.purpose === 'attachment' || row.encrypted) return new UnknownUploadError()
  if (!(PROFILE_IMAGE_TYPES as readonly string[]).includes(row.contentType)) return new InvalidImageError()
  return null
}

/**
 * Avatar / icon / banner: claims the caller's upload as an image and returns
 * its key. Run it in the transaction that stores the key. An image upload may
 * be claimed again; an attachment never.
 */
export async function claimImage(tx: Tx, uploadId: string, userId: string): Promise<string> {
  const mine = and(eq(uploads.id, uploadId), eq(uploads.uploaderId, userId))
  // The SQL form of imageClaimError: keep the two in step.
  const [claimed] = await tx
    .update(uploads)
    .set({ purpose: 'image' })
    .where(
      and(
        mine,
        or(isNull(uploads.purpose), eq(uploads.purpose, 'image')),
        eq(uploads.encrypted, false),
        inArray(uploads.contentType, [...PROFILE_IMAGE_TYPES]),
      ),
    )
    .returning({ key: uploads.key })
  if (claimed) return claimed.key

  const [row] = await tx
    .select({ uploaderId: uploads.uploaderId, purpose: uploads.purpose, encrypted: uploads.encrypted, contentType: uploads.contentType })
    .from(uploads)
    .where(mine)
    .limit(1)
  throw imageClaimError(row ?? null, userId) ?? new UnknownUploadError()
}

/**
 * Attaches `uploadIds` (in order) to a new message inside its transaction.
 * The list holds, per attachment pointer, the file id and then its thumbnail
 * id, so a message delete also removes the thumbnails. Throws UnknownUpload,
 * which rolls the message back, when any id is not the caller's, is not a
 * blob, or already has a purpose.
 */
export async function claimForMessage(
  tx: Tx,
  messageId: string,
  uploadIds: string[],
  userId: string,
): Promise<UploadRow[]> {
  if (uploadIds.length === 0) return []
  if (uploadIds.length > MESSAGE_MAX_UPLOAD_IDS) throw new ValidationError(`A message has at most ${MESSAGE_MAX_UPLOAD_IDS} upload ids`)
  if (new Set(uploadIds).size !== uploadIds.length) throw new ValidationError('Duplicate upload id')
  const ids = sql`array[${sql.join(
    uploadIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`
  const rows = await tx
    .update(uploads)
    .set({
      messageId,
      purpose: 'attachment',
      position: sql`array_position(${ids}, ${uploads.id}) - 1`,
    })
    // The SQL form of messageClaimable: keep the two in step.
    .where(
      and(
        inArray(uploads.id, uploadIds),
        eq(uploads.uploaderId, userId),
        isNull(uploads.purpose),
        eq(uploads.encrypted, true),
      ),
    )
    .returning()
  if (rows.length !== uploadIds.length) {
    const missing = uploadIds.find((id) => !rows.some((r) => r.id === id))
    throw new UnknownUploadError(`Unknown upload ${missing}`)
  }
  return rows.sort((a, b) => a.position - b.position)
}

export type AttachmentScope = { messageId: string } | { channelId: string } | { guildId: string }

/**
 * Deletes the attachment rows of one message, channel or guild and returns
 * their keys. Run it in the transaction that deletes the scope, then pass the
 * keys to deleteObjects after commit: the FK cascade would drop the rows but
 * leave the objects in the bucket.
 */
export async function deleteAttachmentRows(tx: Tx, scope: AttachmentScope): Promise<string[]> {
  let inScope
  if ('messageId' in scope) {
    inScope = eq(uploads.messageId, scope.messageId)
  } else {
    // An insert key-share-locks the row its FK points at, so these locks wait
    // for in-flight channel creates / message sends and block new ones until
    // commit. Without them, a message committed after this DELETE would lose
    // its rows to the cascade without returning its keys.
    if ('guildId' in scope) {
      await tx
        .select({ id: guilds.id })
        .from(guilds)
        .where(eq(guilds.id, scope.guildId))
        .for('update')
    }
    const locked = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(
        'channelId' in scope
          ? eq(channels.id, scope.channelId)
          : eq(channels.guildId, scope.guildId),
      )
      .for('update')
    if (locked.length === 0) return []
    inScope = inArray(
      uploads.messageId,
      tx
        .select({ id: messages.id })
        .from(messages)
        .where(inArray(messages.channelId, locked.map((c) => c.id))),
    )
  }
  const rows = await tx.delete(uploads).where(inScope).returning({ key: uploads.key })
  return rows.map((r) => r.key)
}

/** Attachments per message id, in upload order. */
export async function loadAttachments(messageIds: string[]): Promise<Map<string, Attachment[]>> {
  const out = new Map<string, Attachment[]>()
  if (messageIds.length === 0) return out
  const rows = await db
    .select()
    .from(uploads)
    .where(inArray(uploads.messageId, messageIds))
    .orderBy(asc(uploads.position))
  for (const row of rows) {
    const { messageId } = row
    if (messageId === null) continue
    const list = out.get(messageId) ?? []
    list.push(toAttachment(row))
    out.set(messageId, list)
  }
  return out
}
