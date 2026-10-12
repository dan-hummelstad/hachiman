import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ArrowDown, ArrowUp, FilePlus, Pencil, Trash2 } from 'lucide-react'
import type { PageTreeActions } from '@/components/docs/use-page-tree-actions'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { docsService } from '@/services/docs/DocsService'
import type { PageNode } from '@/stores/docsStore'
import {
  MAX_PAGE_TITLE_BYTES,
  clampTitle,
  moveAmongSiblings,
  pageTitle,
  subtreeIds
} from '@/services/docs/page-tree'

/**
 * The parts of a page tree that the desktop popover and the mobile pages drawer (M42) share: the
 * delete confirm, the hold menu of a row and the title field. The actions are
 * `usePageTreeActions`.
 */

/** The confirm of a page delete, with the count of the sub-pages that go with it. */
export function PageDeleteConfirm({
  pages,
  page,
  onClose
}: {
  pages: readonly PageNode[]
  page: PageNode | null
  onClose: () => void
}): React.JSX.Element {
  const count = page ? subtreeIds(pages, page.id).size : 0
  return (
    <ConfirmDialog
      open={page !== null}
      title="Delete page"
      body={
        page && (
          <>
            Delete <strong>{pageTitle(page)}</strong>
            {count > 1 && ` and its ${count - 1} sub-page${count > 2 ? 's' : ''}`}? This cannot be
            undone.
          </>
        )
      }
      confirmLabel="Delete"
      tone="danger"
      what="delete the page"
      onConfirm={() => (page ? docsService.deletePage(page.id) : Promise.resolve())}
      onClose={onClose}
    />
  )
}

/**
 * The confirm of a move that removes a banner: a top-level page with a banner moves under a page
 * (a drag in the tree), and Takusen clears its banner (contract §4 Pages "Banner").
 */
export function PageMoveConfirm({ actions }: { actions: PageTreeActions }): React.JSX.Element {
  const pending = actions.bannerMove
  const page = pending?.lost[0]
  return (
    <ConfirmDialog
      open={pending !== null}
      title="Move page"
      body={
        page && (
          <>
            This removes the banner of <strong>{pageTitle(page)}</strong>.
          </>
        )
      }
      confirmLabel="Move"
      tone="danger"
      what="move the page"
      onConfirm={() => (pending ? docsService.movePages(pending.moves) : Promise.resolve())}
      onClose={() => actions.setBannerMove(null)}
    />
  )
}

/**
 * The hold menu of a page row on the mobile layout (spec §2.9): New sub-page, Rename, Move up,
 * Move down and Delete. New sub-page and Rename show a field in the list: the sheet closes at
 * once, so that its focus trap lets go, and the field mounts and takes the focus in the same tap,
 * so iOS raises the keyboard (spec §2.8).
 */
export function PageRowMenu({
  page,
  pages,
  actions,
  close,
  onNewSubPage
}: {
  page: PageNode
  pages: readonly PageNode[]
  actions: PageTreeActions
  /** Closes the menu (its `onOpenChange(false)`). */
  close: () => void
  onNewSubPage: () => void
}): React.JSX.Element {
  const handedOff = useRef(false)
  const inTap =
    (then: () => void) =>
    (e: Event): void => {
      e.preventDefault()
      handedOff.current = true
      flushSync(close)
      flushSync(then)
    }
  const up = moveAmongSiblings(pages, page.id, -1)
  const down = moveAmongSiblings(pages, page.id, 1)
  return (
    <ContextMenuContent
      aria-label={pageTitle(page)}
      onCloseAutoFocus={(e) => {
        // The field or the confirm has the focus now.
        if (!handedOff.current) return
        handedOff.current = false
        e.preventDefault()
      }}
    >
      <ContextMenuItem onSelect={inTap(onNewSubPage)}>
        <FilePlus /> New sub-page
      </ContextMenuItem>
      {page.titleState === 'ok' && (
        <ContextMenuItem onSelect={inTap(() => actions.setRenaming(page.id))}>
          <Pencil /> Rename
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem disabled={up.length === 0} onSelect={() => actions.move(up)}>
        <ArrowUp /> Move up
      </ContextMenuItem>
      <ContextMenuItem disabled={down.length === 0} onSelect={() => actions.move(down)}>
        <ArrowDown /> Move down
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onSelect={() => {
          handedOff.current = true
          actions.setDeleting(page)
        }}
      >
        <Trash2 /> Delete
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/**
 * The button path to a row's hold menu (spec §2.9, §6.2): hidden on screen, so VoiceOver, Switch
 * Control and a keyboard can rename, move and delete a page without a hold. It shows while it has
 * the keyboard focus.
 */
export function PageRowActionsButton({
  title,
  onClick
}: {
  title: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={`Actions for ${title}`}
      aria-haspopup="menu"
      onClick={onClick}
      className="text-accent-text focus-visible:outline-line-focus sr-only shrink-0 rounded-[8px] px-2 text-[13px] font-bold outline-none focus-visible:not-sr-only focus-visible:outline-2 focus-visible:-outline-offset-2"
    >
      Actions
    </button>
  )
}

/**
 * The title field of a row (rename, or the title of a new page). Enter or a blur keeps the text,
 * Escape cancels. It takes the focus as it mounts: on a phone, mount it inside the tap (spec §2.8).
 */
export function RenameInput({
  initial,
  onDone,
  className,
  placeholder,
  emptyCancels = false
}: {
  initial: string
  /** The clamped title, or null: cancelled. */
  onDone: (title: string | null) => void
  className?: string
  placeholder?: string
  /** An empty field cancels (a new page), instead of giving "Untitled". */
  emptyCancels?: boolean
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (title: string | null): void => {
    if (done.current) return
    done.current = true
    if (title === null || (emptyCancels && title.trim() === '')) onDone(null)
    else onDone(clampTitle(title))
  }
  return (
    <Input
      autoFocus
      aria-label="Page title"
      value={value}
      placeholder={placeholder}
      maxLength={MAX_PAGE_TITLE_BYTES}
      enterKeyHint="done"
      className={className}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value)
        else if (e.key === 'Escape') {
          e.stopPropagation()
          finish(null)
        }
      }}
    />
  )
}
