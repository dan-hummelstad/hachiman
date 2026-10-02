// Upload policy shared by Oracle and the UI. Contract: docs/gateway-protocol.md §4 Files.
import type { Limits } from './types'

/** Oracle serves `maxUploadBytes` from ORACLE_MAX_UPLOAD_BYTES; these are the defaults. */
export const DEFAULT_LIMITS: Limits = { maxUploadBytes: 26214400, maxAttachmentsPerMessage: 10 }

/** Avatar, guild icon and guild banner uploads must be one of these. */
export const PROFILE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

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
