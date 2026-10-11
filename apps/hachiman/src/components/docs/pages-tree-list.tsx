import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ChevronDown, ChevronRight, FileText, Plus, Search } from 'lucide-react'
import { DndContext, closestCenter } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Permissions, has, type Channel } from '@hachiman/client'
import {
  PageDeleteConfirm,
  PageMoveConfirm,
  PageRowActionsButton,
  PageRowMenu,
  RenameInput
} from '@/components/docs/page-tree-actions'
import {
  INDENT,
  usePageTreeActions,
  type PageTreeActions
} from '@/components/docs/use-page-tree-actions'
import { SectionLabel } from '@/components/mobile/list'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ErrorText } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { usePermissions } from '@/hooks/use-hachiman'
import {
  SORTABLE_TOUCH,
  useDragSensors,
  useSortableHoldMenu,
  useSortableRow
} from '@/hooks/use-sortable-row'
import { useKeyboardOpen } from '@/hooks/use-visual-viewport'
import { cn } from '@/lib/utils'
import {
  channelPageId,
  flattenPages,
  hideCollapsed,
  pageTitle,
  searchRows,
  subtreeEnd,
  type FlatPage
} from '@/services/docs/page-tree'
import {
  setPageCollapsed,
  useChannelPages,
  useCollapsedPages,
  useLastPageId
} from '@/services/docs/use-channel-pages'
import type { PageNode } from '@/stores/docsStore'

/** The width of the disclosure slot at the start of a row: pad 6, chevron 15, gap 8 (M42). */
const SLOT = 'w-[29px] shrink-0'

/** A 40 row (M42): radius 8, the selected one on the accent tint. */
const ROW = 'flex h-10 min-w-0 items-center rounded-[8px] pr-2.5'

/**
 * The pages of a pages channel in the right drawer (M42): a search, the tree with disclosures
 * (the collapsed pages stay for the session) and "New page". A tap opens a page (`onOpen`). A
 * hold drags a row to reorder or nest it, or, when the finger does not move, opens its menu: New
 * sub-page, Rename, Move up, Move down, Delete. The title of a new page is typed in the list, in
 * a field that takes the focus inside the tap, so iOS raises the keyboard (spec §2.8).
 * Recently edited, templates, trash, tags and editor meta are not built (spec §5).
 */
export function PagesTreeList({
  channel,
  onOpen
}: {
  channel: Channel
  onOpen: (pageId: string) => void
}): React.JSX.Element {
  const channelId = channel.id
  const { pages, loaded, failed } = useChannelPages(channelId)
  const canEdit = has(usePermissions(channel.guildId, channelId), Permissions.SEND_MESSAGES)
  const collapsed = useCollapsedPages(channelId)
  const lastId = useLastPageId(channelId)
  const [query, setQuery] = useState('')
  /** A new page whose title is being typed, under `parentId`. */
  const [draft, setDraft] = useState<{ parentId: string | null } | null>(null)

  const rows = useMemo(() => flattenPages(pages), [pages])
  const parents = useMemo(() => new Set(pages.map((p) => p.parentId)), [pages])
  const searching = query.trim() !== ''
  const shown = useMemo(
    () => (searching ? searchRows(rows, query) : hideCollapsed(rows, collapsed)),
    [searching, rows, query, collapsed]
  )
  const actions = usePageTreeActions(channelId, pages, collapsed)
  const sensors = useDragSensors()
  const currentId = channelPageId(pages, null, lastId)

  /** Shows the title field of a new page. Call it inside a tap, under `flushSync`. */
  const beginDraft = (parentId: string | null): void => {
    setQuery('')
    if (parentId !== null) setPageCollapsed(channelId, parentId, false)
    setDraft({ parentId })
  }
  const finishDraft = (title: string | null): void => {
    const parentId = draft?.parentId ?? null
    setDraft(null)
    if (title !== null) void actions.create(parentId, title)
  }

  const draftAt =
    draft === null ? -1 : draft.parentId === null ? shown.length : subtreeEnd(shown, draft.parentId)
  const draftDepth =
    draft?.parentId != null ? (shown.find((r) => r.page.id === draft.parentId)?.depth ?? -1) + 1 : 0
  // One keyed list, so the field of a new page keeps its text when rows come or go around it.
  const items = shown.map((row) => (
    <PageRow
      key={row.page.id}
      row={row}
      pages={pages}
      actions={actions}
      canEdit={canEdit}
      sortable={!searching}
      disclosure={!searching && parents.has(row.page.id)}
      expanded={!collapsed.has(row.page.id)}
      selected={row.page.id === currentId}
      onToggle={() => setPageCollapsed(channelId, row.page.id, !collapsed.has(row.page.id))}
      onOpen={() => onOpen(row.page.id)}
      onNewSubPage={() => beginDraft(row.page.id)}
    />
  ))
  if (draftAt >= 0)
    items.splice(draftAt, 0, <DraftRow key="draft" depth={draftDepth} onDone={finishDraft} />)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pt-2.5">
        <Input
          type="search"
          size="touch"
          lead={<Search />}
          aria-label="Search pages"
          placeholder="Search pages"
          enterKeyHint="search"
          autoCorrect="off"
          autoCapitalize="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-10"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        <SectionLabel className="truncate px-2 pt-3.5 pb-1.5">In #{channel.name}</SectionLabel>
        {!loaded ? (
          failed !== null ? (
            <p className="text-text-tertiary px-2 py-2 text-sm">
              Could not load the pages: {failed}
            </p>
          ) : (
            <div className="flex flex-col gap-3 px-2 py-2" aria-busy="true">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={actions.onDragEnd}
          >
            <SortableContext
              items={shown.map((r) => r.page.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul aria-label="Pages" className="flex flex-col gap-0.5">
                {items}
                {pages.length === 0 && draft === null && (
                  <li className="text-text-tertiary px-2 py-2 text-sm">No pages yet.</li>
                )}
                {searching && shown.length === 0 && (
                  <li className="text-text-tertiary px-2 py-2 text-sm">No page matches.</li>
                )}
                {canEdit && draft === null && (
                  <li>
                    <button
                      type="button"
                      onClick={() => flushSync(() => beginDraft(null))}
                      className={cn(
                        ROW,
                        'text-accent-text active:bg-surface-hover focus-visible:outline-line-focus w-full gap-2 pl-1.5 text-left text-[15px] font-bold outline-none focus-visible:outline-2 focus-visible:-outline-offset-2'
                      )}
                    >
                      <Plus className="size-[17px] shrink-0" aria-hidden />
                      New page
                    </button>
                  </li>
                )}
              </ul>
            </SortableContext>
          </DndContext>
        )}
        <div className="px-2">
          <ErrorText>{actions.error}</ErrorText>
        </div>
      </div>
      <PageMoveConfirm actions={actions} />
      <PageDeleteConfirm
        pages={pages}
        page={actions.deleting}
        onClose={() => actions.setDeleting(null)}
      />
    </div>
  )
}

/** Keeps a field in view in its scroller while the keyboard rises and the list gets shorter. */
function useKeepInView(ref: React.RefObject<HTMLElement | null>, active: boolean): void {
  const keyboard = useKeyboardOpen()
  useEffect(() => {
    if (active && keyboard) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [ref, active, keyboard])
}

function PageRow({
  row,
  pages,
  actions,
  canEdit,
  sortable,
  disclosure,
  expanded,
  selected,
  onToggle,
  onOpen,
  onNewSubPage
}: {
  row: FlatPage
  pages: readonly PageNode[]
  actions: PageTreeActions
  canEdit: boolean
  /** False while the list is a flat search result. */
  sortable: boolean
  /** The page has sub-pages that the disclosure shows or hides. */
  disclosure: boolean
  expanded: boolean
  selected: boolean
  onToggle: () => void
  onOpen: () => void
  onNewSubPage: () => void
}): React.JSX.Element {
  const { page, depth } = row
  const title = pageTitle(page)
  const renaming = actions.renaming === page.id
  const draggable = canEdit && sortable && !renaming
  const { setNodeRef, attributes, listeners, style } = useSortableRow({
    id: page.id,
    disabled: !draggable
  })
  const menu = useSortableHoldMenu(page.id, { sortable: draggable })
  const self = useRef<HTMLLIElement | null>(null)
  useKeepInView(self, renaming)

  const item = (
    <li
      ref={(el) => {
        setNodeRef(el)
        self.current = el
      }}
      style={{ ...style, paddingLeft: depth * INDENT }}
      {...(draggable ? { ...attributes, ...listeners, role: undefined, tabIndex: -1 } : {})}
      className={SORTABLE_TOUCH}
    >
      <div className={cn(ROW, selected ? 'bg-accent-tint' : 'active:bg-surface-hover')}>
        {disclosure ? (
          <button
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title}`}
            aria-expanded={expanded}
            onClick={onToggle}
            className={cn(
              SLOT,
              // The 15 chevron in a 36 wide hit area (spec §2.10).
              "text-text-tertiary relative flex h-full items-center pl-1.5 outline-none after:absolute after:inset-y-0 after:right-[-7px] after:left-0 after:content-['']",
              'focus-visible:outline-line-focus rounded-[8px] focus-visible:outline-2 focus-visible:-outline-offset-2'
            )}
          >
            {expanded ? (
              <ChevronDown className="size-[15px]" aria-hidden />
            ) : (
              <ChevronRight className="size-[15px]" aria-hidden />
            )}
          </button>
        ) : (
          <span className={SLOT} aria-hidden />
        )}
        {renaming ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <FileText className="text-feature-page-text size-[17px] shrink-0" aria-hidden />
            <RenameInput
              initial={page.title}
              onDone={(t) => actions.finishRename(page, t)}
              className="h-9 min-w-0 flex-1 px-2"
            />
          </span>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            aria-current={selected ? 'page' : undefined}
            className="focus-visible:outline-line-focus flex h-full min-w-0 flex-1 items-center gap-2 rounded-[8px] text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
          >
            <FileText className="text-feature-page-text size-[17px] shrink-0" aria-hidden />
            <span
              className={cn(
                'min-w-0 truncate text-[15px] leading-[18px]',
                selected ? 'text-text-primary font-extrabold' : 'text-text-secondary font-semibold',
                page.titleState !== 'ok' && 'text-text-tertiary italic'
              )}
            >
              {title}
            </span>
          </button>
        )}
        {canEdit && !renaming && (
          <PageRowActionsButton title={title} onClick={() => menu.onOpenChange(true)} />
        )}
      </div>
    </li>
  )
  if (!canEdit) return item
  return (
    <ContextMenu open={menu.open} onOpenChange={menu.onOpenChange}>
      <ContextMenuTrigger asChild longPress={menu.longPress}>
        {item}
      </ContextMenuTrigger>
      <PageRowMenu
        page={page}
        pages={pages}
        actions={actions}
        close={() => menu.onOpenChange(false)}
        onNewSubPage={onNewSubPage}
      />
    </ContextMenu>
  )
}

/** The row of a new page while its title is typed: Enter or a blur creates it, empty cancels. */
function DraftRow({
  depth,
  onDone
}: {
  depth: number
  onDone: (title: string | null) => void
}): React.JSX.Element {
  const self = useRef<HTMLLIElement | null>(null)
  useKeepInView(self, true)
  return (
    <li ref={self} style={{ paddingLeft: depth * INDENT }}>
      <div className={ROW}>
        <span className={SLOT} aria-hidden />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <FileText className="text-feature-page-text size-[17px] shrink-0" aria-hidden />
          <RenameInput
            initial=""
            placeholder="Page title"
            emptyCancels
            onDone={onDone}
            className="h-9 min-w-0 flex-1 px-2"
          />
        </span>
      </div>
    </li>
  )
}
