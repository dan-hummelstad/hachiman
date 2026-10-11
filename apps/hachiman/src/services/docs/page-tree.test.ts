import { describe, expect, it } from 'vitest'
import type { PageNode } from '@/stores/docsStore'
import {
  POSITION_STEP,
  channelPageId,
  clampTitle,
  endPosition,
  flattenPages,
  hideCollapsed,
  moveAmongSiblings,
  pagePath,
  projectDrop,
  searchRows,
  subtreeEnd,
  subtreeIds
} from './page-tree'

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

  it('moves a page between two spaced siblings with one PATCH', () => {
    const spaced = [page('x', null, 0), page('y', null, POSITION_STEP), page('z', null, 2048)]
    expect(projectDrop(spaced, 'z', 'y', 0)).toEqual([
      { pageId: 'z', parentId: null, position: 512 }
    ])
  })

  it('renumbers the siblings when the neighbours leave no gap', () => {
    expect(projectDrop(PAGES, 'a2', 'a1', 0)).toEqual([
      { pageId: 'a2', parentId: 'a', position: 0 },
      { pageId: 'a1', parentId: 'a', position: POSITION_STEP }
    ])
  })

  it('nests a page with a drag to the right, one level per indent step', () => {
    expect(projectDrop(PAGES, 'b', 'b', 1)).toEqual([
      { pageId: 'b', parentId: 'a', position: 1 + POSITION_STEP }
    ])
    expect(projectDrop(PAGES, 'b', 'b', 2)).toEqual([{ pageId: 'b', parentId: 'a2', position: 0 }])
  })

  it('un-nests the last child with a drag to the left', () => {
    expect(projectDrop(PAGES, 'a2', 'a2', -1)).toEqual([
      { pageId: 'a2', parentId: null, position: POSITION_STEP },
      { pageId: 'b', parentId: null, position: 2 * POSITION_STEP }
    ])
  })

  it('gives a new page the end position', () => {
    expect(endPosition(PAGES, 'a')).toBe(1 + POSITION_STEP)
    expect(endPosition(PAGES, 'b')).toBe(0)
  })

  it('cannot nest a page into its own subtree', () => {
    // a moves below b with its subtree; the deepest place is under b.
    const moves = projectDrop(PAGES, 'a', 'b', 5)
    expect(moves).toEqual([{ pageId: 'a', parentId: 'b', position: 0 }])
  })

  it('makes no move for a drop in place', () => {
    expect(projectDrop(PAGES, 'a1', 'a1', 0)).toEqual([])
  })

  it('hides the rows below a collapsed page, at any depth', () => {
    const rows = flattenPages([...PAGES, page('a1x', 'a1', 0)])
    const ids = (collapsed: string[]): string[] =>
      hideCollapsed(rows, new Set(collapsed)).map((r) => r.page.id)
    expect(hideCollapsed(rows, new Set())).toBe(rows)
    expect(ids(['a'])).toEqual(['a', 'b'])
    expect(ids(['a1'])).toEqual(['a', 'a1', 'a2', 'b'])
    // A collapsed page inside a collapsed page changes nothing more.
    expect(ids(['a', 'a1'])).toEqual(['a', 'b'])
    expect(ids(['b'])).toEqual(['a', 'a1', 'a1x', 'a2', 'b'])
  })

  it('finds the end of a subtree in the rows', () => {
    const rows = flattenPages(PAGES)
    expect(subtreeEnd(rows, 'a')).toBe(3)
    expect(subtreeEnd(rows, 'a1')).toBe(2)
    expect(subtreeEnd(rows, 'b')).toBe(4)
    expect(subtreeEnd(rows, 'gone')).toBe(-1)
  })

  it('searches the titles, flat', () => {
    const rows = flattenPages(PAGES)
    expect(searchRows(rows, '  ')).toBe(rows)
    expect(searchRows(rows, 'A2').map((r) => `${r.page.id}:${r.depth}`)).toEqual(['a2:0'])
    expect(searchRows(rows, 'zz')).toEqual([])
  })

  it('names the open page, else the last one, else the first of the tree', () => {
    expect(channelPageId(PAGES, 'a2', 'b')).toBe('a2')
    expect(channelPageId(PAGES, null, 'b')).toBe('b')
    // A page that is gone (deleted) falls through.
    expect(channelPageId(PAGES, 'gone', 'gone')).toBe('a')
    expect(channelPageId([], null, null)).toBeNull()
  })

  it('moves a page one place among its siblings', () => {
    expect(moveAmongSiblings(PAGES, 'a', 1)).toEqual([
      { pageId: 'a', parentId: null, position: 1 + POSITION_STEP }
    ])
    // No gap above a1: the siblings are renumbered.
    expect(moveAmongSiblings(PAGES, 'a2', -1)).toEqual([
      { pageId: 'a2', parentId: 'a', position: 0 },
      { pageId: 'a1', parentId: 'a', position: POSITION_STEP }
    ])
    expect(moveAmongSiblings(PAGES, 'a', -1)).toEqual([])
    expect(moveAmongSiblings(PAGES, 'a2', 1)).toEqual([])
    expect(moveAmongSiblings(PAGES, 'gone', 1)).toEqual([])
  })

  it('drops between the rows that show when a page is collapsed', () => {
    const pages = [
      page('x', null, 0),
      page('a', null, POSITION_STEP),
      page('a1', 'a', 0),
      page('b', null, 2 * POSITION_STEP)
    ]
    // Expanded: below a is a1, so x lands as a's first child.
    expect(projectDrop(pages, 'x', 'a', 0)).toEqual([
      { pageId: 'x', parentId: 'a', position: 0 },
      { pageId: 'a1', parentId: 'a', position: POSITION_STEP }
    ])
    // Collapsed: below a is b, so x stays a root page between them.
    const collapsed = new Set(['a'])
    expect(projectDrop(pages, 'x', 'a', 0, collapsed)).toEqual([
      { pageId: 'x', parentId: null, position: 1536 }
    ])
    // A drag to the right nests it after a's hidden sub-pages.
    expect(projectDrop(pages, 'x', 'a', 1, collapsed)).toEqual([
      { pageId: 'x', parentId: 'a', position: POSITION_STEP }
    ])
  })

  it('clamps a title to 200 UTF-8 bytes', () => {
    expect(clampTitle('  ')).toBe('Untitled')
    expect(new TextEncoder().encode(clampTitle('文'.repeat(100))).length).toBeLessThanOrEqual(200)
  })
})
