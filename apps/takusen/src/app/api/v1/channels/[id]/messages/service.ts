/**
 * Ciphertext message writes (docs/gateway-protocol.md §4, §12.8.4, §12.8.6).
 *
 * Takusen stores the envelope and the header fields that `acceptEnvelope`
 * returns. It never decrypts. The routes run these functions in one
 * transaction over `drizzleMessageStore`. Tests run them over a fake store.
 */
import { eq } from 'drizzle-orm'

import type { Tx } from '@/db/client'
import { messages, type MessageRow, type UploadRow } from '@/db/schema'
import { ApiError, MissingPermissionsError } from '@/lib/errors'
import type { AcceptedEnvelope, EnvelopeInput } from '@/lib/mls/envelopes'
import { claimForMessage, deleteAttachmentRows } from '@/lib/uploads'
import { messageEditPatch, messageInsertValues, type CreateMessageBody } from '@/lib/wire'

export type NewMessage = ReturnType<typeof messageInsertValues>
export type MessagePatch = ReturnType<typeof messageEditPatch>

/** The writes of the message routes, one method per behavior. */
export interface MessageStore {
  /** Throws 409 DuplicateMessage when (channel, client_msg_id) exists. */
  insert(values: NewMessage): Promise<MessageRow>
  update(id: string, patch: MessagePatch): Promise<MessageRow>
  /** The §4 message claim: every id or none (400 UnknownUpload). */
  claim(messageId: string, uploadIds: string[], userId: string): Promise<UploadRow[]>
  /** Deletes the upload rows of the message (files and thumbnails) and the message. Returns the object keys. */
  delete(messageId: string): Promise<string[]>
}

/** `acceptEnvelope` bound to the route transaction. */
export type AcceptEnvelope = (input: EnvelopeInput) => Promise<AcceptedEnvelope>

/** POST /channels/:id/messages after the permission checks. */
export async function sendMessage(
  store: MessageStore,
  accept: AcceptEnvelope,
  input: { channelId: string; userId: string; deviceId: string; body: CreateMessageBody },
): Promise<{ row: MessageRow; claimed: UploadRow[] }> {
  const accepted = await accept({ channelId: input.channelId, userId: input.userId, deviceId: input.deviceId, envelope: input.body.envelope, edit: false })
  const row = await store.insert(messageInsertValues({ channelId: input.channelId, authorId: input.userId, envelope: input.body.envelope, accepted }))
  const claimed = await store.claim(row.id, input.body.attachments, input.userId)
  return { row, claimed }
}

/**
 * PATCH /channels/:id/messages/:mid: author only. The edit header repeats the
 * client_msg_id of the row. Takusen replaces the envelope and the header
 * columns and sets edited_at. The attachment rows stay.
 */
export async function editMessage(
  store: MessageStore,
  accept: AcceptEnvelope,
  input: { row: MessageRow; userId: string; deviceId: string; envelope: Uint8Array; now: Date },
): Promise<MessageRow> {
  if (input.row.authorId !== input.userId) throw new MissingPermissionsError('Only the author can edit a message')
  const accepted = await accept({
    channelId: input.row.channelId,
    userId: input.userId,
    deviceId: input.deviceId,
    envelope: input.envelope,
    edit: true,
    rowClientMsgId: input.row.clientMsgId,
  })
  return store.update(input.row.id, messageEditPatch(input.envelope, accepted, input.now))
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === '23505') return true
  }
  return false
}

export function drizzleMessageStore(tx: Tx): MessageStore {
  return {
    async insert(values) {
      try {
        // acceptEnvelope checks uniqueness. The index catches a concurrent send of the same id.
        const [row] = await tx.insert(messages).values(values).returning()
        return row!
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError('DuplicateMessage', 409, 'the client_msg_id exists in the channel')
        throw err
      }
    },
    async update(id, patch) {
      const [row] = await tx.update(messages).set(patch).where(eq(messages.id, id)).returning()
      if (!row) throw new ApiError('NotFound', 404, 'Unknown message')
      return row
    },
    claim: (messageId, uploadIds, userId) => claimForMessage(tx, messageId, uploadIds, userId),
    async delete(messageId) {
      const keys = await deleteAttachmentRows(tx, { messageId })
      await tx.delete(messages).where(eq(messages.id, messageId))
      return keys
    },
  }
}
