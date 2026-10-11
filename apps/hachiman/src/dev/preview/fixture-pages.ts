// Preview fixture, pages (contract §4 Pages): two linked pages in #design-pages (the RFC has a
// banner, its Glossary sub-page shows it) and the scrim playbook (no banner) in #scrim-playbook,
// as stub doc envelopes. ./stubs.ts seeds its in-memory page routes from fixturePages().
import type { DocUpdate, Page } from '@hachiman/client'
import {
  STUB_MARKER,
  toB64url,
  type AttachmentPointer,
  type DocEnvelopeKindName
} from '@hachiman/crypto'
import * as Y from 'yjs'
import { ATT } from './attachments'
import { DAY, G1C, G2C, U, groupOf, now } from './fixture'

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
  glossary: '8d2f3c5b-6e4a-4f7b-8c9d-1e2f3a4b5c6d',
  playbook: '9e3a4d6c-7f5b-4a8c-9d0e-2f3a4b5c6d7e'
}

export function fixturePages(): { pages: Page[]; updates: Map<string, DocUpdate[]> } {
  const page = (
    channelId: string,
    id: string,
    title: string,
    parentId: string | null,
    position: number,
    banner: AttachmentPointer | null = null
  ): Page => ({
    id,
    channelId,
    parentId,
    position,
    titleEnvelope: stubDocEnvelope(channelId, id, 'doc_title', new TextEncoder().encode(title)),
    bannerEnvelope:
      banner === null
        ? null
        : stubDocEnvelope(
            channelId,
            id,
            'doc_banner',
            new TextEncoder().encode(JSON.stringify(banner))
          ),
    createdBy: U.yuki.id,
    createdAt: daysAgo(3),
    updatedAt: daysAgo(1)
  })
  const update = (channelId: string, pageId: string, blocks: Block[]): DocUpdate => ({
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
      page(G2C.designPages, PAGE.rfc, 'RFC: pages channels', null, 0, ATT.pageBanner),
      page(G2C.designPages, PAGE.glossary, 'Glossary', PAGE.rfc, 0),
      page(G1C.playbook, PAGE.playbook, 'Scrim playbook', null, 0)
    ],
    updates: new Map([
      [
        PAGE.rfc,
        [
          update(G2C.designPages, PAGE.rfc, [
            { heading: 'RFC: pages channels' },
            ['A pages channel keeps the chat in the center and the page on the right.'],
            ['The terms are in the ', { text: 'Glossary', href: pageLink(PAGE.glossary) }, '.']
          ])
        ]
      ],
      [
        PAGE.glossary,
        [
          update(G2C.designPages, PAGE.glossary, [
            { heading: 'Glossary' },
            ['Page: one markdown document of a pages channel.'],
            ['Back to the ', { text: 'RFC', href: pageLink(PAGE.rfc) }, '.']
          ])
        ]
      ],
      [
        PAGE.playbook,
        [
          update(G1C.playbook, PAGE.playbook, [
            { heading: 'Scrim playbook' },
            ['Thursday 21:00 CET. Double-support comp against their dive.'],
            ['Callouts: left is from the attacker spawn. Rotate on the second pick.']
          ])
        ]
      ]
    ])
  }
}
