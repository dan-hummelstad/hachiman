import { describe, expect, it } from 'vitest'
import type { AttachmentDraft, AttachmentPointer } from '@hachiman/crypto'
import { pointerOf, uploadIdsOf } from './attachments'

const draft = (thumbnail: boolean): AttachmentDraft => ({
  key: 'K',
  sha256: 'H',
  size: 10,
  blobSize: 100,
  mime: 'image/png',
  name: 'a.png',
  width: 4,
  height: 3,
  durationMs: null,
  blurhash: null,
  thumbnail: thumbnail
    ? { key: 'TK', sha256: 'TH', size: 5, blobSize: 50, mime: 'image/webp', width: 4, height: 3 }
    : null
})

const pointer = (id: string, thumbId: string | null): AttachmentPointer =>
  pointerOf(
    draft(thumbId !== null),
    { id, key: `${id}/blob`, size: 100 },
    thumbId ? { id: thumbId, key: `${thumbId}/blob`, size: 50 } : null
  )

describe('uploadIdsOf', () => {
  it('lists each file id, then its thumbnail id (§12.8.5 step 8)', () => {
    expect(uploadIdsOf([pointer('f1', 't1'), pointer('f2', null), pointer('f3', 't3')])).toEqual([
      'f1',
      't1',
      'f2',
      'f3',
      't3'
    ])
  })

  it('refuses more than MAX_MESSAGE_UPLOAD_IDS ids', () => {
    const many = Array.from({ length: 11 }, (_, i) => pointer(`f${i}`, `t${i}`))
    expect(() => uploadIdsOf(many)).toThrow('at most 20')
  })
})

describe('pointerOf', () => {
  it('fills the upload ids', () => {
    const p = pointer('f1', 't1')
    expect(p.uploadId).toBe('f1')
    expect(p.thumbnail?.uploadId).toBe('t1')
    expect(p.name).toBe('a.png')
  })

  it('refuses an upload whose stored size differs from the blob', () => {
    expect(() => pointerOf(draft(false), { id: 'f', key: 'f/blob', size: 99 }, null)).toThrow(
      'different file size'
    )
    expect(() =>
      pointerOf(
        draft(true),
        { id: 'f', key: 'f/blob', size: 100 },
        { id: 't', key: 't/blob', size: 1 }
      )
    ).toThrow('different thumbnail size')
  })

  it('refuses a draft thumbnail without its upload', () => {
    expect(() => pointerOf(draft(true), { id: 'f', key: 'f/blob', size: 100 }, null)).toThrow(
      'did not upload'
    )
  })
})
