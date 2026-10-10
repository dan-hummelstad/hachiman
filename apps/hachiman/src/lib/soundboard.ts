/**
 * The pure rules of the soundboard (contract §4 Soundboard, §12.21): the clip limits, the channel
 * whose group seals the pointer, and the pointer codec.
 */
import type { Channel } from '@hachiman/client'
import { fromB64url } from '@hachiman/crypto'

export const SOUND_MAX_BYTES = 512 * 1024
export const SOUND_MAX_SECONDS = 5
/** Decoders round the length of a 5 s clip a little up. */
const DURATION_SLACK_S = 0.05
export const SOUND_NAME_MAX = 32
export const SOUND_ACCEPT = '.mp3,.ogg,.oga,.wav,audio/mpeg,audio/ogg,audio/wav'

export type SoundMime = 'audio/mpeg' | 'audio/ogg' | 'audio/wav'

/**
 * The pointer body of the sound envelope (§12.21). `fileKey` and `sha256` are base64url. It has
 * exactly the four fields of a snapshot pointer (§12.20), which the crypto Worker enforces. No
 * MIME type: decodeAudioData reads the format from the bytes.
 */
export interface SoundPointer {
  uploadId: string
  fileKey: string
  sha256: string
  size: number
}

/** The clip type from the MIME type or, when the browser gives none, the extension. */
export function soundMime(file: Pick<File, 'type' | 'name'>): SoundMime | null {
  const t = file.type.toLowerCase()
  if (t === 'audio/mpeg' || t === 'audio/mp3') return 'audio/mpeg'
  if (t === 'audio/ogg' || t === 'application/ogg') return 'audio/ogg'
  if (t === 'audio/wav' || t === 'audio/x-wav' || t === 'audio/wave' || t === 'audio/vnd.wave') return 'audio/wav'
  if (t !== '') return null
  const ext = file.name.toLowerCase().split('.').pop()
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'ogg' || ext === 'oga') return 'audio/ogg'
  if (ext === 'wav') return 'audio/wav'
  return null
}

/** Why the clip cannot be a sound, or null. `durationS` is null before the decode. */
export function clipProblem(file: Pick<File, 'type' | 'name' | 'size'>, durationS: number | null): string | null {
  if (!soundMime(file)) return 'Use an MP3, OGG or WAV file.'
  if (file.size > SOUND_MAX_BYTES) return 'A sound is at most 512 KB.'
  if (durationS !== null && durationS > SOUND_MAX_SECONDS + DURATION_SLACK_S) return 'A sound is at most 5 seconds long.'
  return null
}

/** True when the group id (§12.6: version, kind, scope, generation) is of kind public_set (1). */
export function isPublicSetGroup(mlsGroupId: string | null): boolean {
  if (!mlsGroupId) return false
  try {
    const bytes = fromB64url(mlsGroupId)
    return bytes.length === 22 && bytes[0] === 1 && bytes[1] === 1
  } catch {
    return false
  }
}

/**
 * The channel whose group seals a sound pointer: the first text or pages channel of the guild (by
 * position) that uses the public_set group, so that every member can read the pointer. Null when
 * the guild has none.
 */
export function soundChannel(channels: Iterable<Channel>, guildId: string): Channel | null {
  let best: Channel | null = null
  for (const c of channels) {
    if (c.guildId !== guildId || (c.type !== 'text' && c.type !== 'pages')) continue
    if (!isPublicSetGroup(c.mlsGroupId)) continue
    if (!best || c.position < best.position || (c.position === best.position && c.id < best.id)) best = c
  }
  return best
}

export function encodeSoundPointer(p: SoundPointer): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(p))
}

/** The pointer of `bytes`, or null when it does not decode or names another upload. */
export function decodeSoundPointer(bytes: Uint8Array, uploadId: string): SoundPointer | null {
  let v: unknown
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const p = v as Record<string, unknown>
  if (
    p.uploadId !== uploadId ||
    typeof p.fileKey !== 'string' ||
    typeof p.sha256 !== 'string' ||
    typeof p.size !== 'number' ||
    !Number.isInteger(p.size) ||
    p.size < 0 ||
    p.size > SOUND_MAX_BYTES
  )
    return null
  return { uploadId, fileKey: p.fileKey, sha256: p.sha256, size: p.size }
}
