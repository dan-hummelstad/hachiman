// "Move to…" of the page actions sheet (M41): a page moves to the top level of its own channel
// or under another page of it. A move to another channel does not exist (spec F3b, section 5).
import { endPosition, flattenPages, subtreeIds, type PageMove } from '@/services/docs/page-tree'
import type { PageNode } from '@/stores/docsStore'

/** A place that "Move to…" offers. */
export interface PageMoveTarget {
  /** The new parent: null for the top level of the channel. */
  parentId: string | null
  /** The new parent page: null for the top level. */
  page: PageNode | null
  /** The page that moves sits here now. */
  current: boolean
}

/**
 * The parent of `page` as the tree shows it. A page whose parent is missing shows as a root page
 * (`flattenPages`), so it is at the top level.
 */
function shownParent(pages: readonly PageNode[], page: PageNode): string | null {
  const { parentId } = page
  return parentId !== null && pages.some((p) => p.id === parentId) ? parentId : null
}

/**
 * The places that `pageId` can move to: the top level first, then every page that is not the page
 * or below it, in tree order. Empty when the page is not in the list.
 */
export function pageMoveTargets(pages: readonly PageNode[], pageId: string): PageMoveTarget[] {
  const page = pages.find((p) => p.id === pageId)
  if (!page) return []
  const parentId = shownParent(pages, page)
  const below = subtreeIds(pages, pageId)
  return [
    { parentId: null, page: null, current: parentId === null },
    ...flattenPages(pages)
      .filter((r) => !below.has(r.page.id))
      .map((r) => ({ parentId: r.page.id, page: r.page, current: r.page.id === parentId }))
  ]
}

/**
 * The PATCH that puts `pageId` last under `parentId` (null: the top level). None when the page is
 * there now, when either page is not in the list, or when `parentId` is the page or below it.
 */
export function moveUnder(
  pages: readonly PageNode[],
  pageId: string,
  parentId: string | null
): PageMove[] {
  const page = pages.find((p) => p.id === pageId)
  if (!page || shownParent(pages, page) === parentId) return []
  if (parentId !== null) {
    if (!pages.some((p) => p.id === parentId)) return []
    if (subtreeIds(pages, pageId).has(parentId)) return []
  }
  return [{ pageId, parentId, position: endPosition(pages, parentId) }]
}

/**
 * The pages whose banner `moves` remove. Takusen clears the banner of a page that moves under a
 * parent (contract §4 Pages "Banner"), so "Move to…" and a drag in the tree confirm it first. A
 * banner that has not decrypted yet counts too: the server still holds it.
 */
export function bannersLost(pages: readonly PageNode[], moves: readonly PageMove[]): PageNode[] {
  return moves.flatMap((m) => {
    if (m.parentId === null) return []
    const page = pages.find((p) => p.id === m.pageId)
    return page && (page.banner !== null || page.bannerPending) ? [page] : []
  })
}
