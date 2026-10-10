import { describe, expect, it } from 'vitest'
import type { Channel } from '@hachiman/client'
import { toB64url } from '@hachiman/crypto'
import {
  SOUND_MAX_BYTES,
  clipProblem,
  decodeSoundPointer,
  encodeSoundPointer,
  isPublicSetGroup,
  soundChannel,
  soundMime
} from './soundboard'

const groupId = (kind: number): string => {
  const b = new Uint8Array(22)
  b[0] = 1
  b[1] = kind
  return toB64url(b)
}

const channel = (id: string, over: Partial<Channel>): Channel => ({
  id,
  guildId: 'g',
  type: 'text',
  name: id,
  topic: null,
  parentId: null,
  position: 0,
  permissionOverwrites: [],
  mlsGroupId: groupId(1),
  historyVisibility: 'shared',
  ...over
})

describe('soundboard rules', () => {
  it('reads the clip type from the MIME type or the extension', () => {
    expect(soundMime({ type: 'audio/x-wav', name: 'a' })).toBe('audio/wav')
    expect(soundMime({ type: '', name: 'Horn.MP3' })).toBe('audio/mpeg')
    expect(soundMime({ type: 'audio/flac', name: 'a.ogg' })).toBeNull()
  })

  it('limits the size and the duration', () => {
    const ok = { type: 'audio/ogg', name: 'a.ogg', size: SOUND_MAX_BYTES }
    expect(clipProblem(ok, 5)).toBeNull()
    expect(clipProblem({ ...ok, size: SOUND_MAX_BYTES + 1 }, null)).toMatch(/512 KB/)
    expect(clipProblem(ok, 5.2)).toMatch(/5 seconds/)
  })

  it('picks the first public text or pages channel of the guild', () => {
    const list = [
      channel('voice', { type: 'voice', mlsGroupId: null, position: 0 }),
      channel('private', { mlsGroupId: groupId(2), position: 0 }),
      channel('other', { guildId: 'h', position: 0 }),
      channel('second', { position: 2 }),
      channel('first', { type: 'pages', position: 1 })
    ]
    expect(soundChannel(list, 'g')?.id).toBe('first')
    expect(soundChannel([list[1]!], 'g')).toBeNull()
    expect(isPublicSetGroup('not base64!')).toBe(false)
  })

  it('round-trips the pointer and refuses one for another upload', () => {
    const p = { uploadId: 'u1', fileKey: 'k', sha256: 's', size: 10 }
    const bytes = encodeSoundPointer(p)
    expect(decodeSoundPointer(bytes, 'u1')).toEqual(p)
    expect(decodeSoundPointer(bytes, 'u2')).toBeNull()
    expect(decodeSoundPointer(new TextEncoder().encode('{"uploadId":"u1"}'), 'u1')).toBeNull()
  })
})
