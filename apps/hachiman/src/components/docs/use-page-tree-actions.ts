import { useCallback, useState } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import { useAction } from '@/hooks/use-action'
import { docsService } from '@/services/docs/DocsService'
import type { PageNode } from '@/stores/docsStore'
import { projectDrop, type PageMove } from '@/services/docs/page-tree'
import { bannersLost } from './page-move'

/** Pixels of one nesting level, in the rows and in the drag projection. */
export const INDENT = 16

const NONE: ReadonlySet<string> = new Set()

/** A move that removes the banner of `lost` (a top-level page that goes under a page). */
export interface BannerMove {
  moves: PageMove[]
  lost: PageNode[]
}

export interface PageTreeActions {
  /** The last failed action, as "Could not …". */
  error: string | null
  /** The page whose title is being edited in its row. */
  renaming: string | null
  setRenaming: (pageId: string | null) => void
  /** Creates a page at the end of `parentId`'s sub-pages. Its id, or null after an error. */
  create: (parentId: string | null, title?: string) => Promise<string | null>
  /** The end of a row's title edit: `title` null when cancelled. */
  finishRename: (page: PageNode, title: string | null) => void
  /** Moves the pages, or first asks for the confirm of a move that removes a banner. */
  move: (moves: PageMove[]) => void
  /** The move that waits for its banner confirm (`PageMoveConfirm`). */
  bannerMove: BannerMove | null
  setBannerMove: (move: BannerMove | null) => void
  /** The `onDragEnd` of the tree's `DndContext`. */
  onDragEnd: (event: DragEndEvent) => void
  /** The page whose delete waits for its confirm (`PageDeleteConfirm`). */
  deleting: PageNode | null
  setDeleting: (page: PageNode | null) => void
}

/**
 * The actions of a page tree (the desktop popover and the mobile pages drawer): create, rename,
 * move, drag and delete, with the error of the last one. `collapsed`: the pages whose sub-pages
 * the list hides, for the drag projection.
 */
export function usePageTreeActions(
  channelId: string,
  pages: readonly PageNode[],
  collapsed: ReadonlySet<string> = NONE
): PageTreeActions {
  const { run, error } = useAction()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<PageNode | null>(null)
  const [bannerMove, setBannerMove] = useState<BannerMove | null>(null)

  const create = useCallback(
    async (parentId: string | null, title = 'Untitled'): Promise<string | null> => {
      const r = await run('create the page', () =>
        docsService.createPage(channelId, title, parentId)
      )
      return r.ok ? r.value : null
    },
    [run, channelId]
  )

  const finishRename = useCallback(
    (page: PageNode, title: string | null): void => {
      setRenaming(null)
      if (title !== null && title !== page.title)
        void run('rename the page', () => docsService.renamePage(page.id, title))
    },
    [run]
  )

  const move = useCallback(
    (moves: PageMove[]): void => {
      if (moves.length === 0) return
      // Takusen clears the banner of a page that moves under a page (contract §4 Pages "Banner").
      const lost = bannersLost(pages, moves)
      if (lost.length > 0) setBannerMove({ moves, lost })
      else void run('move the page', () => docsService.movePages(moves))
    },
    [run, pages]
  )

  const onDragEnd = useCallback(
    ({ active, over, delta }: DragEndEvent): void => {
      if (!over) return
      move(
        projectDrop(
          pages,
          String(active.id),
          String(over.id),
          Math.round(delta.x / INDENT),
          collapsed
        )
      )
    },
    [move, pages, collapsed]
  )

  return {
    error,
    renaming,
    setRenaming,
    create,
    finishRename,
    move,
    bannerMove,
    setBannerMove,
    onDragEnd,
    deleting,
    setDeleting
  }
}
