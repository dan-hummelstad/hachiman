// Upload policy shared by Takusen and the UI. Contract: docs/gateway-protocol.md §4 Files.
import type { Limits } from './types'

/** Takusen serves the live values from TAKUSEN_MAX_UPLOAD_BYTES and TAKUSEN_MAX_ENVELOPE_BYTES; these are the defaults. */
export const DEFAULT_LIMITS: Limits = {
  maxUploadBytes: 26214400,
  maxAttachmentsPerMessage: 10,
  maxEnvelopeBytes: 32768,
  maxPageSnapshotBytes: 104857600,
}

/** Avatar, guild icon and guild banner uploads must be one of these. */
export const PROFILE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/** File key of an encrypted blob (§4 Files). Give it to RestClient.fileUrl or fetchBlob. */
export const blobKey = (uploadId: string): string => `${uploadId}/blob`

// For attachments, the MIME type comes from the decrypted envelope, not from the server.
export const EMBEDDABLE = {
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'],
  video: ['video/mp4', 'video/webm', 'video/ogg'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac', 'audio/mp4', 'audio/aac'],
} as const satisfies Record<string, readonly string[]>

export type EmbedKind = 'image' | 'video' | 'audio' | 'file'

export function embedKind(contentType: string): EmbedKind {
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  for (const kind of ['image', 'video', 'audio'] as const)
    if ((EMBEDDABLE[kind] as readonly string[]).includes(type)) return kind
  return 'file'
}
