/**
 * Upload claims and attachment loading (docs/gateway-protocol.md §4 Files).
 * The first claim sets `uploads.purpose`; each claim is one conditional UPDATE,
 * so of two concurrent claims with different purposes only one wins.
 *
 * A message claims only encrypted blobs (`?kind=blob`). An avatar, icon or
 * banner claims only plaintext profile images (`?filename=`).
 */
import { and, asc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm'
import { PROFILE_IMAGE_TYPES } from '@hachiman/client/files'
import type { Attachment } from '@hachiman/client/types'

import { db, type Tx } from '@/db/client'
import { channels, docPages, guilds, messages, uploads, type UploadRow } from '@/db/schema'
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
 * leave the objects in the bucket. A channel or guild scope also takes the
 * page uploads (page_snapshot, page_media) of its pages; a channel scope gives
 * their bytes back to guilds.page_storage_bytes (§4 Pages).
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
    const channelIds = locked.map((c) => c.id)
    // The same for page claims: they key-share-lock the page row.
    const pages = await tx
      .select({ id: docPages.id })
      .from(docPages)
      .where(inArray(docPages.channelId, channelIds))
      .for('update')
    const ofPages = pages.length > 0 ? inArray(uploads.pageId, pages.map((p) => p.id)) : null
    if (ofPages && 'channelId' in scope) await releasePageStorage(tx, ofPages)
    const ofMessages = inArray(
      uploads.messageId,
      tx
        .select({ id: messages.id })
        .from(messages)
        .where(inArray(messages.channelId, channelIds)),
    )
    inScope = ofPages ? or(ofMessages, ofPages)! : ofMessages
  }
  const rows = await tx.delete(uploads).where(inScope).returning({ key: uploads.key })
  return rows.map((r) => r.key)
}

/**
 * Subtracts the bytes of the page uploads that match `where` from the
 * guilds.page_storage_bytes of their guilds (§4 Pages quota). Call it in the
 * transaction that deletes those rows, before the delete.
 */
export async function releasePageStorage(tx: Tx, where: SQL): Promise<void> {
  const freed = await tx
    .select({ guildId: channels.guildId, bytes: sql<string>`sum(${uploads.size})` })
    .from(uploads)
    .innerJoin(docPages, eq(docPages.id, uploads.pageId))
    .innerJoin(channels, eq(channels.id, docPages.channelId))
    .where(and(isNotNull(uploads.pageId), where))
    .groupBy(channels.guildId)
  for (const f of freed) {
    if (!f.guildId) continue
    await tx
      .update(guilds)
      .set({ pageStorageBytes: sql`greatest(0, ${guilds.pageStorageBytes} - ${Number(f.bytes)})` })
      .where(eq(guilds.id, f.guildId))
  }
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

// MARK: - Page claims (§4 Pages)

type PageClaimView = Pick<UploadRow, 'uploaderId' | 'purpose' | 'encrypted' | 'pageId'>

/** The rule of the snapshot claim: an unclaimed `?kind=page_snapshot` blob of the caller. */
export function pageSnapshotClaimable(row: PageClaimView, userId: string): boolean {
  return row.uploaderId === userId && row.encrypted && row.purpose === 'page_snapshot' && row.pageId === null
}

/**
 * The rule of the media claim: an encrypted blob of the caller that is
 * unclaimed (a new claim, as messageClaimable) or media of this page (a refresh).
 */
export function pageMediaClaimable(row: PageClaimView, userId: string, pageId: string): boolean {
  if (row.uploaderId !== userId || !row.encrypted) return false
  return row.purpose === null || (row.purpose === 'page_media' && row.pageId === pageId)
}

/** Claims a snapshot blob for `pageId`. Throws UnknownUpload. */
export async function claimPageSnapshot(tx: Tx, pageId: string, uploadId: string, userId: string): Promise<{ key: string; size: number }> {
  // The SQL form of pageSnapshotClaimable: keep the two in step.
  const [row] = await tx
    .update(uploads)
    .set({ pageId })
    .where(
      and(
        eq(uploads.id, uploadId),
        eq(uploads.uploaderId, userId),
        eq(uploads.encrypted, true),
        eq(uploads.purpose, 'page_snapshot'),
        isNull(uploads.pageId),
      ),
    )
    .returning({ key: uploads.key, size: uploads.size })
  if (!row) throw new UnknownUploadError(`Unknown upload ${uploadId}`)
  return row
}

/**
 * Claims media blobs for `pageId` and sets last_referenced_at on each. Returns
 * the bytes of the new claims (a refresh adds none). Throws UnknownUpload when
 * any id is not claimable.
 */
export async function claimPageMedia(tx: Tx, pageId: string, uploadIds: string[], userId: string, now: Date): Promise<number> {
  const mine = and(inArray(uploads.id, uploadIds), eq(uploads.uploaderId, userId), eq(uploads.encrypted, true))
  // The SQL form of pageMediaClaimable: keep the two in step. The new claims
  // go first, so a concurrent claim of the same id finds it as a refresh.
  const claimed = await tx
    .update(uploads)
    .set({ purpose: 'page_media', pageId, lastReferencedAt: now })
    .where(and(mine, isNull(uploads.purpose)))
    .returning({ id: uploads.id, size: uploads.size })
  const refreshed = await tx
    .update(uploads)
    .set({ lastReferencedAt: now })
    .where(and(mine, eq(uploads.purpose, 'page_media'), eq(uploads.pageId, pageId)))
    .returning({ id: uploads.id })
  const found = new Set([...claimed, ...refreshed].map((r) => r.id))
  const missing = uploadIds.find((id) => !found.has(id))
  if (missing) throw new UnknownUploadError(`Unknown upload ${missing}`)
  return claimed.reduce((n, r) => n + r.size, 0)
}

function pageUploadsWhere(scope: { pageIds: string[] } | { uploadIds: string[] }): SQL {
  return 'pageIds' in scope ? inArray(uploads.pageId, scope.pageIds) : and(inArray(uploads.id, scope.uploadIds), isNotNull(uploads.pageId))!
}

/**
 * Deletes the claimed page uploads of some pages, or some of them by id, gives
 * their bytes back to the guild quota and returns their keys and sizes. Pass
 * the keys to deleteObjects after commit.
 */
export async function deletePageUploadRows(tx: Tx, scope: { pageIds: string[] } | { uploadIds: string[] }): Promise<{ key: string; size: number }[]> {
  if (('pageIds' in scope ? scope.pageIds : scope.uploadIds).length === 0) return []
  const where = pageUploadsWhere(scope)
  await releasePageStorage(tx, where)
  return tx.delete(uploads).where(where).returning({ key: uploads.key, size: uploads.size })
}
