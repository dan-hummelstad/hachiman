// Pure helpers over the flat page list of a channel (docsStore.pagesByChannel).
import { useDocsStore, type PageNode } from '@/stores/docsStore'

/** One row of the page tree as the popover renders it: depth-first order. */
export interface FlatPage {
  page: PageNode
  depth: number
}

/** The children of each parent id ('' = the root pages), in position order. */
function childrenByParent(pages: readonly PageNode[]): Map<string, PageNode[]> {
  const out = new Map<string, PageNode[]>()
  for (const p of pages) {
    const key = p.parentId ?? ''
    const list = out.get(key)
    if (list) list.push(p)
    else out.set(key, [p])
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
  }
  return out
}

/** Depth-first rows. A page whose parent is missing shows as a root page. */
export function flattenPages(pages: readonly PageNode[]): FlatPage[] {
  const ids = new Set(pages.map((p) => p.id))
  const kids = childrenByParent(pages)
  const roots = pages
    .filter((p) => p.parentId === null || !ids.has(p.parentId))
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
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

/** A page of any loaded pages channel. */
export function findPage(pageId: string): PageNode | undefined {
  for (const list of useDocsStore.getState().pagesByChannel.values()) {
    const page = list.find((p) => p.id === pageId)
    if (page) return page
  }
  return undefined
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

/** The next free position under `parentId`. */
export function endPosition(pages: readonly PageNode[], parentId: string | null): number {
  let max = -1
  for (const p of pages) if (p.parentId === parentId && p.position > max) max = p.position
  return max + 1
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

/** One PATCH of a drop: the page and the parent and position it gets. */
export interface PageMove {
  pageId: string
  parentId: string | null
  position: number
}

/**
 * The PATCHes of a drag in the tree. The row of `activeId` goes to the place of the row of
 * `overId`, and `depthDelta` (the horizontal drag in indent steps) nests or un-nests it, in the
 * range that the rows above and below allow (the sortable-tree projection of dnd-kit).
 * Takusen does not renumber siblings, so the result renumbers the new siblings too. Only
 * the pages whose parent or position changes get a PATCH.
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
  const siblings = pages
    .filter((p) => p.parentId === parentId && p.id !== activeId)
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
  const order = moved.map((r) => r.page.id)
  const idx = order.indexOf(activeId)
  const insertAt = siblings.filter((s) => order.indexOf(s.id) < idx).length
  const ordered = [...siblings]
  ordered.splice(insertAt, 0, active.page)

  const out: PageMove[] = []
  ordered.forEach((p, position) => {
    if (p.id === activeId) {
      if (p.parentId !== parentId || p.position !== position) {
        out.push({ pageId: p.id, parentId, position })
      }
    } else if (p.position !== position) {
      out.push({ pageId: p.id, parentId, position })
    }
  })
  return out
}
