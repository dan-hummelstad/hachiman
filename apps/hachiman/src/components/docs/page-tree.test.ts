import { describe, expect, it } from 'vitest'
import type { PageNode } from '@/stores/docsStore'
import { clampTitle, flattenPages, pagePath, projectDrop, subtreeIds } from './page-tree'
import { pageIdOfHref, pageHref } from './page-links'

const page = (id: string, parentId: string | null, position: number): PageNode => ({
  id,
  channelId: 'c',
  parentId,
  position,
  title: id,
  titleState: 'ok',
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
})

// a
//   a1
//   a2
// b
const PAGES = [page('b', null, 1), page('a2', 'a', 1), page('a', null, 0), page('a1', 'a', 0)]

describe('page tree', () => {
  it('flattens depth first in position order', () => {
    expect(flattenPages(PAGES).map((r) => `${r.page.id}:${r.depth}`)).toEqual([
      'a:0',
      'a1:1',
      'a2:1',
      'b:0'
    ])
  })

  it('shows a page with a missing parent as a root page', () => {
    expect(flattenPages([page('x', 'gone', 0)]).map((r) => r.depth)).toEqual([0])
  })

  it('gives the path and the subtree', () => {
    expect(pagePath(PAGES, 'a2').map((p) => p.id)).toEqual(['a', 'a2'])
    expect([...subtreeIds(PAGES, 'a')].sort()).toEqual(['a', 'a1', 'a2'])
  })

  it('reorders siblings and renumbers them', () => {
    expect(projectDrop(PAGES, 'a2', 'a1', 0)).toEqual([
      { pageId: 'a2', parentId: 'a', position: 0 },
      { pageId: 'a1', parentId: 'a', position: 1 }
    ])
  })

  it('nests a page with a drag to the right, one level per indent step', () => {
    expect(projectDrop(PAGES, 'b', 'b', 1)).toEqual([{ pageId: 'b', parentId: 'a', position: 2 }])
    expect(projectDrop(PAGES, 'b', 'b', 2)).toEqual([{ pageId: 'b', parentId: 'a2', position: 0 }])
  })

  it('un-nests the last child with a drag to the left', () => {
    expect(projectDrop(PAGES, 'a2', 'a2', -1)).toEqual([
      { pageId: 'a2', parentId: null, position: 1 },
      { pageId: 'b', parentId: null, position: 2 }
    ])
  })

  it('cannot nest a page into its own subtree', () => {
    // a moves below b with its subtree; the deepest place is under b.
    const moves = projectDrop(PAGES, 'a', 'b', 5)
    expect(moves).toEqual([{ pageId: 'a', parentId: 'b', position: 0 }])
  })

  it('makes no move for a drop in place', () => {
    expect(projectDrop(PAGES, 'a1', 'a1', 0)).toEqual([])
  })

  it('clamps a title to 200 UTF-8 bytes', () => {
    expect(clampTitle('  ')).toBe('Untitled')
    expect(new TextEncoder().encode(clampTitle('文'.repeat(100))).length).toBeLessThanOrEqual(200)
  })
})

describe('page links', () => {
  it('round-trips a page href', () => {
    const id = '0190a6f2-7f3c-7a51-9e0b-2b9f6c3d4e5f'
    expect(pageIdOfHref(pageHref(id))).toBe(id)
    expect(pageIdOfHref('https://example.com')).toBeNull()
    expect(pageIdOfHref('hachiman:page/../x')).toBeNull()
  })
})
