// Pure helpers over the flat page list of a channel (docsStore.pagesByChannel).
import type { PageNode } from '@/stores/docsStore'

/**
 * The gap between the positions that this client gives. A move to a place between two siblings
 * takes the midpoint, so it is one PATCH. Takusen does not renumber siblings (§4 Pages "Move"):
 * only when the neighbours leave no gap does a move renumber them.
 */
export const POSITION_STEP = 1024
/** doc_pages.position is an int (§3, the PATCH schema caps it). */
const MAX_POSITION = 2 ** 31 - 1

/** One row of the page tree as the popover renders it: depth-first order. */
export interface FlatPage {
  page: PageNode
  depth: number
}

/** One PATCH of a drop: the page and the parent and position it gets. */
export interface PageMove {
  pageId: string
  parentId: string | null
  position: number
}

const siblingOrder = (a: PageNode, b: PageNode): number =>
  a.position - b.position || a.createdAt.localeCompare(b.createdAt)

const siblingsOf = (pages: readonly PageNode[], parentId: string | null): PageNode[] =>
  pages.filter((p) => p.parentId === parentId).sort(siblingOrder)

/** The children of each parent id ('' = the root pages), in position order. */
function childrenByParent(pages: readonly PageNode[]): Map<string, PageNode[]> {
  const out = new Map<string, PageNode[]>()
  for (const p of pages) {
    const key = p.parentId ?? ''
    const list = out.get(key)
    if (list) list.push(p)
    else out.set(key, [p])
  }
  for (const list of out.values()) list.sort(siblingOrder)
  return out
}

/** Depth-first rows. A page whose parent is missing shows as a root page. */
export function flattenPages(pages: readonly PageNode[]): FlatPage[] {
  const ids = new Set(pages.map((p) => p.id))
  const kids = childrenByParent(pages)
  const roots = pages.filter((p) => p.parentId === null || !ids.has(p.parentId)).sort(siblingOrder)
  const out: FlatPage[] = []
  const seen = new Set<string>()
  const walk = (p: PageNode, depth: number): void => {
    if (seen.has(p.id)) return
    seen.add(p.id)
    out.push({ page: p, depth })
    for (const c of kids.get(p.id) ?? []) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  return out
}

/**
 * The rows that show while each page in `collapsed` hides its sub-pages (the disclosure of the
 * mobile page list): the rows below a collapsed page go, at any depth.
 */
export function hideCollapsed(
  rows: readonly FlatPage[],
  collapsed: ReadonlySet<string>
): readonly FlatPage[] {
  if (collapsed.size === 0) return rows
  const out: FlatPage[] = []
  let hideBelow = Infinity
  for (const row of rows) {
    if (row.depth > hideBelow) continue
    hideBelow = collapsed.has(row.page.id) ? row.depth : Infinity
    out.push(row)
  }
  return out
}

/**
 * The index after the last row below `pageId` in `rows` (depth-first): where a new sub-page
 * shows while its title is typed. -1 when the page has no row.
 */
export function subtreeEnd(rows: readonly FlatPage[], pageId: string): number {
  const at = rows.findIndex((r) => r.page.id === pageId)
  if (at < 0) return -1
  let end = at + 1
  while (end < rows.length && rows[end].depth > rows[at].depth) end++
  return end
}

/** The rows whose title contains `query` (case-insensitive), flat. An empty query keeps all. */
export function searchRows(rows: readonly FlatPage[], query: string): readonly FlatPage[] {
  const q = query.trim().toLowerCase()
  if (q === '') return rows
  return rows
    .filter((r) => pageTitle(r.page).toLowerCase().includes(q))
    .map((r) => ({ page: r.page, depth: 0 }))
}

/**
 * The page that a pages channel names on its chat (the mobile page bar): the open page, else
 * `lastId` (the page opened last), else the first page of the tree. Null for no pages.
 */
export function channelPageId(
  pages: readonly PageNode[],
  openId: string | null,
  lastId: string | null
): string | null {
  for (const id of [openId, lastId]) if (id !== null && pages.some((p) => p.id === id)) return id
  return flattenPages(pages)[0]?.page.id ?? null
}

/** The pages from the root to `pageId` (inclusive). Empty when the page is not in the list. */
export function pagePath(pages: readonly PageNode[], pageId: string): PageNode[] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const path: PageNode[] = []
  let cur = byId.get(pageId)
  while (cur && !path.includes(cur)) {
    path.unshift(cur)
    cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined
  }
  return path
}

/** The ids of `pageId` and of every page below it. */
export function subtreeIds(pages: readonly PageNode[], pageId: string): Set<string> {
  const kids = childrenByParent(pages)
  const out = new Set<string>()
  const walk = (id: string): void => {
    if (out.has(id)) return
    out.add(id)
    for (const c of kids.get(id) ?? []) walk(c.id)
  }
  walk(pageId)
  return out
}

/** A free position after `lo` and before `hi` (undefined: no sibling there), or null for none. */
function between(lo: number | undefined, hi: number | undefined): number | null {
  if (hi === undefined) {
    const p = lo === undefined ? 0 : lo + POSITION_STEP
    return p <= MAX_POSITION ? p : null
  }
  const low = lo ?? -1
  const mid = Math.floor((low + hi) / 2)
  return mid > low && mid < hi ? mid : null
}

export function endPosition(pages: readonly PageNode[], parentId: string | null): number {
  const last = siblingsOf(pages, parentId).at(-1)
  return between(last?.position, undefined) ?? MAX_POSITION
}

/** The title to show; an empty or undecrypted title gets a placeholder. */
export function pageTitle(page: Pick<PageNode, 'title' | 'titleState'>): string {
  if (page.titleState === 'pending') return 'Decrypting…'
  if (page.titleState === 'failed') return 'Unreadable page'
  return page.title.trim() || 'Untitled'
}

/** The cap of a title in UTF-8 bytes (MAX_PAGE_TITLE_BYTES of @hachiman/crypto, §12.20). */
export const MAX_PAGE_TITLE_BYTES = 200

/** A title as it is sent: trimmed, at most MAX_PAGE_TITLE_BYTES bytes, 'Untitled' when empty. */
export function clampTitle(title: string): string {
  const enc = new TextEncoder()
  let out = ''
  for (const ch of title.trim()) {
    if (enc.encode(out + ch).length > MAX_PAGE_TITLE_BYTES) break
    out += ch
  }
  return out.trim() || 'Untitled'
}

/**
 * The PATCHes that put `page` at `insertAt` among `siblings` (the pages of `parentId` without
 * it). Usually one PATCH, of `page`. When its new neighbours leave no gap, the siblings are
 * renumbered (POSITION_STEP), and only the pages whose position changes get a PATCH.
 */
function placeAmong(
  page: PageNode,
  parentId: string | null,
  siblings: readonly PageNode[],
  insertAt: number
): PageMove[] {
  const position = between(siblings[insertAt - 1]?.position, siblings[insertAt]?.position)
  if (position !== null) return [{ pageId: page.id, parentId, position }]
  const ordered = [...siblings]
  ordered.splice(insertAt, 0, page)
  return ordered.flatMap((p, i) =>
    p.position === i * POSITION_STEP && p.parentId === parentId
      ? []
      : [{ pageId: p.id, parentId, position: i * POSITION_STEP }]
  )
}

/**
 * The PATCHes that move a page one place up (-1) or down (1) among its siblings, under the same
 * parent (the Move items of the hold menu). Empty when it is first or last already.
 */
export function moveAmongSiblings(
  pages: readonly PageNode[],
  pageId: string,
  step: -1 | 1
): PageMove[] {
  const page = pages.find((p) => p.id === pageId)
  if (!page) return []
  const siblings = siblingsOf(pages, page.parentId)
  const at = siblings.indexOf(page) + step
  if (at < 0 || at >= siblings.length) return []
  return placeAmong(
    page,
    page.parentId,
    siblings.filter((p) => p !== page),
    at
  )
}

const NONE: ReadonlySet<string> = new Set()

/**
 * The PATCHes of a drag in the tree. The row of `activeId` goes to the place of the row of
 * `overId`, and `depthDelta` (the horizontal drag in indent steps) nests or un-nests it, in the
 * range that the rows above and below allow (the sortable-tree projection of dnd-kit).
 * Usually one PATCH, of the dragged page (POSITION_STEP). When its new neighbours leave no gap,
 * the new siblings are renumbered, and only the pages whose position changes get a PATCH.
 * `collapsed`: the pages whose sub-pages the list hides (`hideCollapsed`). A drop goes between
 * the rows that show, so a drop under a collapsed page does not land in its hidden sub-pages.
 */
export function projectDrop(
  pages: readonly PageNode[],
  activeId: string,
  overId: string,
  depthDelta: number,
  collapsed: ReadonlySet<string> = NONE
): PageMove[] {
  const all = hideCollapsed(flattenPages(pages), collapsed)
  const active = all.find((r) => r.page.id === activeId)
  if (!active) return []
  const below = subtreeIds(pages, activeId)
  // The rows without the subtree of the dragged page, with the dragged row moved to `overId`.
  const rows = all.filter((r) => r.page.id === activeId || !below.has(r.page.id))
  const from = rows.findIndex((r) => r.page.id === activeId)
  const to = rows.findIndex((r) => r.page.id === overId)
  if (from < 0 || to < 0) return []
  const moved = [...rows]
  moved.splice(to, 0, ...moved.splice(from, 1))
  const prev = moved[to - 1]
  const next = moved[to + 1]
  const maxDepth = prev ? prev.depth + 1 : 0
  const minDepth = next ? next.depth : 0
  const depth = Math.min(maxDepth, Math.max(minDepth, active.depth + depthDelta))

  // The parent is the nearest row above at depth - 1.
  let parentId: string | null = null
  if (depth > 0) {
    for (let i = to - 1; i >= 0; i--) {
      if (moved[i].depth === depth - 1) {
        parentId = moved[i].page.id
        break
      }
    }
  }

  // The new sibling order: the rows above `to` under the same parent, the page, then the rest.
  // The hidden sub-pages of a collapsed row above count as above.
  const before = new Set<string>()
  for (const { page: above } of moved.slice(0, to)) {
    if (collapsed.has(above.id)) for (const id of subtreeIds(pages, above.id)) before.add(id)
    else before.add(above.id)
  }
  const siblings = siblingsOf(pages, parentId).filter((p) => p.id !== activeId)
  const insertAt = siblings.filter((s) => before.has(s.id)).length
  const page = active.page
  if (page.parentId === parentId && siblingsOf(pages, parentId).indexOf(page) === insertAt)
    return []
  return placeAmong(page, parentId, siblings, insertAt)
}
