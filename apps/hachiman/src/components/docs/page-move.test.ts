import { describe, expect, it } from 'vitest'
import type { AttachmentPointer } from '@hachiman/crypto'
import type { PageNode } from '@/stores/docsStore'
import { POSITION_STEP } from '@/services/docs/page-tree'
import { bannersLost, moveUnder, pageMoveTargets } from './page-move'

const page = (id: string, parentId: string | null, position: number): PageNode => ({
  id,
  channelId: 'c',
  parentId,
  position,
  title: id,
  titleState: 'ok',
  banner: null,
  bannerPending: false,
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
})

// a
//   a1
//     a1x
//   a2
// b
const PAGES = [
  page('b', null, POSITION_STEP),
  page('a2', 'a', POSITION_STEP),
  page('a', null, 0),
  page('a1', 'a', 0),
  page('a1x', 'a1', 0)
]

const shown = (targets: ReturnType<typeof pageMoveTargets>): string[] =>
  targets.map((t) => `${t.parentId ?? 'top'}${t.current ? '*' : ''}`)

describe('pageMoveTargets', () => {
  it('offers the top level, then the pages outside the subtree, in tree order', () => {
    expect(shown(pageMoveTargets(PAGES, 'a1'))).toEqual(['top', 'a*', 'a2', 'b'])
  })

  it('marks the top level for a root page', () => {
    expect(shown(pageMoveTargets(PAGES, 'b'))).toEqual(['top*', 'a', 'a1', 'a1x', 'a2'])
  })

  it('treats a page whose parent is missing as a root page', () => {
    const pages = [...PAGES, page('orphan', 'gone', 0)]
    expect(pageMoveTargets(pages, 'orphan')[0]).toEqual({
      parentId: null,
      page: null,
      current: true
    })
  })

  it('gives nothing for a page that is not in the list', () => {
    expect(pageMoveTargets(PAGES, 'nope')).toEqual([])
  })
})

describe('moveUnder', () => {
  it('puts the page last under the new parent', () => {
    expect(moveUnder(PAGES, 'b', 'a')).toEqual([
      { pageId: 'b', parentId: 'a', position: 2 * POSITION_STEP }
    ])
    expect(moveUnder(PAGES, 'a1x', null)).toEqual([
      { pageId: 'a1x', parentId: null, position: 2 * POSITION_STEP }
    ])
  })

  it('does nothing where the page is now', () => {
    expect(moveUnder(PAGES, 'a1', 'a')).toEqual([])
    expect(moveUnder(PAGES, 'b', null)).toEqual([])
    expect(moveUnder([...PAGES, page('orphan', 'gone', 0)], 'orphan', null)).toEqual([])
  })

  it('never moves a page under itself, below itself or under a missing page', () => {
    expect(moveUnder(PAGES, 'a', 'a')).toEqual([])
    expect(moveUnder(PAGES, 'a', 'a1x')).toEqual([])
    expect(moveUnder(PAGES, 'b', 'gone')).toEqual([])
    expect(moveUnder(PAGES, 'nope', null)).toEqual([])
  })
})

describe('bannersLost', () => {
  const BANNER: AttachmentPointer = {
    uploadId: 'up-1',
    key: '',
    sha256: '',
    size: 1000,
    blobSize: 1000,
    mime: 'image/webp',
    name: 'banner.webp',
    width: 1600,
    height: 400,
    durationMs: null,
    blurhash: null,
    thumbnail: null
  }
  const withBanner = PAGES.map((p) => (p.id === 'a' ? { ...p, banner: BANNER } : p))

  it('names a top-level page with a banner that moves under a page', () => {
    expect(bannersLost(withBanner, moveUnder(withBanner, 'a', 'b')).map((p) => p.id)).toEqual(['a'])
  })

  it('counts a banner that has not decrypted yet', () => {
    const pending = PAGES.map((p) => (p.id === 'a' ? { ...p, bannerPending: true } : p))
    expect(bannersLost(pending, moveUnder(pending, 'a', 'b')).map((p) => p.id)).toEqual(['a'])
  })

  it('names nothing for a move at the top level, a page with no banner or an unknown page', () => {
    expect(bannersLost(withBanner, [{ pageId: 'a', parentId: null, position: 5 }])).toEqual([])
    expect(bannersLost(withBanner, moveUnder(withBanner, 'b', 'a'))).toEqual([])
    expect(bannersLost(withBanner, [{ pageId: 'gone', parentId: 'b', position: 0 }])).toEqual([])
  })
})
