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
 * The PATCHes of a drag in the tree. The row of `activeId` goes to the place of the row of
 * `overId`, and `depthDelta` (the horizontal drag in indent steps) nests or un-nests it, in the
 * range that the rows above and below allow (the sortable-tree projection of dnd-kit).
 * Usually one PATCH, of the dragged page (POSITION_STEP). When its new neighbours leave no gap,
 * the new siblings are renumbered, and only the pages whose position changes get a PATCH.
 */
export function projectDrop(
  pages: readonly PageNode[],
  activeId: string,
  overId: string,
  depthDelta: number
): PageMove[] {
  const all = flattenPages(pages)
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
  const before = new Set(moved.slice(0, to).map((r) => r.page.id))
  const siblings = siblingsOf(pages, parentId).filter((p) => p.id !== activeId)
  const insertAt = siblings.filter((s) => before.has(s.id)).length
  const page = active.page
  if (page.parentId === parentId && siblingsOf(pages, parentId).indexOf(page) === insertAt)
    return []

  const position = between(siblings[insertAt - 1]?.position, siblings[insertAt]?.position)
  if (position !== null) return [{ pageId: activeId, parentId, position }]
  const ordered = [...siblings]
  ordered.splice(insertAt, 0, page)
  return ordered.flatMap((p, i) =>
    p.position === i * POSITION_STEP && p.parentId === parentId
      ? []
      : [{ pageId: p.id, parentId, position: i * POSITION_STEP }]
  )
}
