import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { AttachmentPointer } from '@hachiman/crypto'
import { MEDIA_NODE, collectMediaUploadIds, parsePointer } from './media'

const B64 = 'A'.repeat(43)
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const pointer = (n: number, overrides: Partial<AttachmentPointer> = {}): AttachmentPointer => ({
  uploadId: uuid(n),
  key: B64,
  sha256: B64,
  size: 10,
  blobSize: 20,
  mime: 'image/png',
  name: 'cat.png',
  width: 4,
  height: 3,
  durationMs: null,
  blurhash: null,
  thumbnail: null,
  ...overrides
})

function media(p: unknown): Y.XmlElement {
  const el = new Y.XmlElement(MEDIA_NODE)
  el.setAttribute('pointer', typeof p === 'string' ? p : JSON.stringify(p))
  return el
}

describe('parsePointer', () => {
  it('keeps only the known fields of a valid pointer', () => {
    const p = pointer(1)
    expect(parsePointer(JSON.stringify({ ...p, extra: 'x' }))).toEqual(p)
  })

  it('rejects bad JSON, a bad id, key or size, and a bad thumbnail', () => {
    expect(parsePointer('{')).toBeNull()
    expect(parsePointer(42)).toBeNull()
    expect(parsePointer(JSON.stringify(pointer(1, { uploadId: '../x' })))).toBeNull()
    expect(parsePointer(JSON.stringify(pointer(1, { key: 'bad/key' })))).toBeNull()
    expect(parsePointer(JSON.stringify(pointer(1, { size: -1 })))).toBeNull()
    const thumb = { ...pointer(2), width: 'wide' }
    expect(parsePointer(JSON.stringify({ ...pointer(1), thumbnail: thumb }))).toBeNull()
  })
})

describe('collectMediaUploadIds', () => {
  it('lists the file and thumbnail ids of nested media nodes once, and skips bad ones', () => {
    const doc = new Y.Doc()
    const frag = doc.getXmlFragment('prosemirror')
    const quote = new Y.XmlElement('blockquote')
    const thumbnail = { ...pointer(3), width: 2, height: 1 }
    quote.insert(0, [media(pointer(2, { thumbnail })), media('not json')])
    frag.insert(0, [media(pointer(1)), quote, media(pointer(1))])
    expect(collectMediaUploadIds(doc).sort()).toEqual([uuid(1), uuid(2), uuid(3)])
  })
})
