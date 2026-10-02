// Preview fixture, pages (contract §4 Pages): two linked pages in #design-pages, as stub doc
// envelopes. ./stubs.ts seeds its in-memory page routes from fixturePages().
import type { DocUpdate, Page } from '@hachiman/client'
import { STUB_MARKER, toB64url, type DocEnvelopeKindName } from '@hachiman/crypto'
import * as Y from 'yjs'
import { DAY, G2C, U, groupOf, now } from './fixture'

/** The stub crypto client's doc envelope (createCryptoStub): base64url JSON, NOT ENCRYPTED. */
export function stubDocEnvelope(
  channelId: string,
  pageId: string,
  kind: DocEnvelopeKindName,
  bytes: Uint8Array
): string {
  const env = { marker: STUB_MARKER, channelId, pageId, kind, bytes: toB64url(bytes) }
  return toB64url(new TextEncoder().encode(JSON.stringify(env)))
}

type Inline = string | { text: string; href: string }
type Block = { heading: string } | Inline[]

/** A Yjs update of a ProseMirror doc in the "prosemirror" fragment (y-prosemirror, Milkdown). */
function pageDoc(blocks: Block[]): Uint8Array {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('prosemirror')
  doc.transact(() => {
    frag.insert(
      0,
      blocks.map((b) => new Y.XmlElement('heading' in b ? 'heading' : 'paragraph'))
    )
    blocks.forEach((b, i) => {
      const el = frag.get(i) as Y.XmlElement<{ level?: number }>
      const text = new Y.XmlText()
      el.insert(0, [text])
      if ('heading' in b) {
        // y-prosemirror keeps node attrs as they are; Milkdown's heading level is a number.
        el.setAttribute('level', 1)
        text.insert(0, b.heading)
        return
      }
      for (const part of b) {
        // Explicit null: Yjs carries the format of the text before an insert forward.
        if (typeof part === 'string') text.insert(text.length, part, { link: null })
        else text.insert(text.length, part.text, { link: { href: part.href, title: null } })
      }
    })
  })
  return Y.encodeStateAsUpdate(doc)
}

const pageLink = (pageId: string): string => `hachiman:page/${pageId}`
const daysAgo = (d: number): string => new Date(now - d * DAY).toISOString()

export const PAGE = {
  rfc: '7c1e2b4a-5d3f-4e6a-9b8c-0d1e2f3a4b5c',
  glossary: '8d2f3c5b-6e4a-4f7b-8c9d-1e2f3a4b5c6d'
}

export function fixturePages(): { pages: Page[]; updates: Map<string, DocUpdate[]> } {
  const channelId = G2C.designPages
  const page = (id: string, title: string, parentId: string | null, position: number): Page => ({
    id,
    channelId,
    parentId,
    position,
    titleEnvelope: stubDocEnvelope(channelId, id, 'doc_title', new TextEncoder().encode(title)),
    createdBy: U.yuki.id,
    createdAt: daysAgo(3),
    updatedAt: daysAgo(1)
  })
  const update = (pageId: string, blocks: Block[]): DocUpdate => ({
    pageId,
    seq: 1,
    groupId: groupOf(channelId),
    epoch: 3,
    senderDevice: `d-${U.yuki.id}`,
    envelope: stubDocEnvelope(channelId, pageId, 'doc_update', pageDoc(blocks)),
    createdAt: daysAgo(1)
  })
  return {
    pages: [
      page(PAGE.rfc, 'RFC: pages channels', null, 0),
      page(PAGE.glossary, 'Glossary', PAGE.rfc, 0)
    ],
    updates: new Map([
      [
        PAGE.rfc,
        [
          update(PAGE.rfc, [
            { heading: 'RFC: pages channels' },
            ['A pages channel keeps the chat in the center and the page on the right.'],
            ['The terms are in the ', { text: 'Glossary', href: pageLink(PAGE.glossary) }, '.']
          ])
        ]
      ],
      [
        PAGE.glossary,
        [
          update(PAGE.glossary, [
            { heading: 'Glossary' },
            ['Page: one markdown document of a pages channel.'],
            ['Back to the ', { text: 'RFC', href: pageLink(PAGE.rfc) }, '.']
          ])
        ]
      ]
    ])
  }
}
