import {
  MAX_MESSAGE_UPLOAD_IDS,
  type AttachmentDraft,
  type AttachmentPointer
} from '@hachiman/crypto'
import type { Attachment } from '@hachiman/client'

/**
 * The `attachments` list of POST /channels/:id/messages (§12.8.5 step 8): for each pointer, the
 * file id, then its thumbnail id when it has one. The receiver checks this order.
 */
export function uploadIdsOf(pointers: readonly AttachmentPointer[]): string[] {
  const ids = pointers.flatMap((p) =>
    p.thumbnail ? [p.uploadId, p.thumbnail.uploadId] : [p.uploadId]
  )
  if (ids.length > MAX_MESSAGE_UPLOAD_IDS)
    throw new Error(`A message can carry at most ${MAX_MESSAGE_UPLOAD_IDS} uploads.`)
  return ids
}

/**
 * The pointer of an uploaded draft. Each upload must have the blob size of the draft: the
 * receivers compare the pointer with the upload rows.
 */
export function pointerOf(
  draft: AttachmentDraft,
  file: Attachment,
  thumbnail: Attachment | null
): AttachmentPointer {
  if (file.size !== draft.blobSize) throw new Error('The server stored a different file size.')
  if (draft.thumbnail === null) return { ...draft, uploadId: file.id, thumbnail: null }
  if (!thumbnail) throw new Error('The thumbnail did not upload.')
  if (thumbnail.size !== draft.thumbnail.blobSize)
    throw new Error('The server stored a different thumbnail size.')
  return { ...draft, uploadId: file.id, thumbnail: { ...draft.thumbnail, uploadId: thumbnail.id } }
}
