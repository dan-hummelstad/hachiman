import { useMemo, useRef, useState } from 'react'
import { FilePlus, FileText, GripVertical, ListTree, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAction } from '@/hooks/use-action'
import { cn } from '@/lib/utils'
import { docsService } from '@/services/docs/DocsService'
import type { PageNode } from '@/stores/docsStore'
import {
  MAX_PAGE_TITLE_BYTES,
  clampTitle,
  endPosition,
  flattenPages,
  pageTitle,
  projectDrop,
  subtreeIds,
  type FlatPage
} from './page-tree'

/** Pixels of one nesting level, in the rows and in the drag projection. */
const INDENT = 16

export interface PageTreePopoverProps {
  channelId: string
  pages: readonly PageNode[]
  openPageId: string | null
  canEdit: boolean
  onOpen: (pageId: string) => void
}

/** The page tree of a pages channel: open, create, rename, delete, and drag to reorder or nest. */
export function PageTreePopover(props: PageTreePopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label="Pages" tooltipSide="bottom" pressed={open}>
          <ListTree />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
        <PageTree
          {...props}
          onOpen={(id) => {
            setOpen(false)
            props.onOpen(id)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function PageTree({
  channelId,
  pages,
  openPageId,
  canEdit,
  onOpen
}: PageTreePopoverProps): React.JSX.Element {
  const rows = useMemo(() => flattenPages(pages), [pages])
  const { run, error } = useAction()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<PageNode | null>(null)
  // 4px activation distance so a click isn't swallowed as a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const create = async (parentId: string | null): Promise<void> => {
    const r = await run('create the page', () =>
      docsService.createPage(channelId, 'Untitled', {
        parentId,
        position: endPosition(pages, parentId)
      })
    )
    if (r.ok) setRenaming(r.value)
  }

  const onDragEnd = ({ active, over, delta }: DragEndEvent): void => {
    if (!over) return
    const moves = projectDrop(
      pages,
      String(active.id),
      String(over.id),
      Math.round(delta.x / INDENT)
    )
    if (moves.length === 0) return
    void run('move the page', async () => {
      for (const m of moves) await docsService.movePage(m.pageId, m)
    })
  }

  const deleteCount = deleting ? subtreeIds(pages, deleting.id).size : 0

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          Pages
        </span>
        {canEdit && (
          <IconButton label="New page" size="sm" onClick={() => void create(null)}>
            <Plus />
          </IconButton>
        )}
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={rows.map((r) => r.page.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex max-h-96 flex-col gap-px overflow-y-auto">
            {rows.map((row) => (
              <TreeRow
                key={row.page.id}
                row={row}
                selected={row.page.id === openPageId}
                canEdit={canEdit}
                renaming={renaming === row.page.id}
                onOpen={() => onOpen(row.page.id)}
                onAddChild={() => void create(row.page.id)}
                onRename={() => setRenaming(row.page.id)}
                onRenameDone={(title) => {
                  setRenaming(null)
                  if (title !== null && title !== row.page.title) {
                    void run('rename the page', () => docsService.renamePage(row.page.id, title))
                  }
                }}
                onDelete={() => setDeleting(row.page)}
              />
            ))}
            {rows.length === 0 && (
              <li className="text-muted-foreground px-2 py-1.5 text-sm">No pages yet.</li>
            )}
          </ul>
        </SortableContext>
      </DndContext>
      <ErrorText>{error}</ErrorText>
      <ConfirmDialog
        open={deleting !== null}
        title="Delete page"
        body={
          deleting && (
            <>
              Delete <strong>{pageTitle(deleting)}</strong>
              {deleteCount > 1 &&
                ` and its ${deleteCount - 1} sub-page${deleteCount > 2 ? 's' : ''}`}
              ? This cannot be undone.
            </>
          )
        }
        confirmLabel="Delete"
        tone="danger"
        what="delete the page"
        onConfirm={() => (deleting ? docsService.deletePage(deleting.id) : Promise.resolve())}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}

function TreeRow({
  row,
  selected,
  canEdit,
  renaming,
  onOpen,
  onAddChild,
  onRename,
  onRenameDone,
  onDelete
}: {
  row: FlatPage
  selected: boolean
  canEdit: boolean
  renaming: boolean
  onOpen: () => void
  onAddChild: () => void
  onRename: () => void
  /** null: cancelled. */
  onRenameDone: (title: string | null) => void
  onDelete: () => void
}): React.JSX.Element {
  const { page, depth } = row
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: page.id,
    disabled: !canEdit || renaming
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1 : undefined,
    paddingLeft: depth * INDENT
  }

  return (
    <li ref={setNodeRef} style={style}>
      <div
        className={cn(
          'group hover:bg-accent flex h-8 items-center gap-1 pr-1',
          selected && 'bg-accent text-foreground'
        )}
      >
        {canEdit ? (
          <span
            {...attributes}
            {...listeners}
            aria-label="Drag to move"
            className="text-muted-foreground flex size-5 shrink-0 cursor-grab items-center justify-center opacity-0 group-hover:opacity-100"
          >
            <GripVertical className="size-3.5" />
          </span>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <FileText className="text-muted-foreground size-4 shrink-0" />
        {renaming ? (
          <RenameInput initial={page.title} onDone={onRenameDone} />
        ) : (
          <button
            type="button"
            className={cn(
              'min-w-0 flex-1 truncate text-left text-sm',
              page.titleState !== 'ok' && 'text-muted-foreground italic'
            )}
            onClick={onOpen}
          >
            {pageTitle(page)}
          </button>
        )}
        {canEdit && !renaming && (
          <span className="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            <IconButton label="New sub-page" size="sm" onClick={onAddChild}>
              <FilePlus />
            </IconButton>
            {page.titleState === 'ok' && (
              <IconButton label="Rename" size="sm" onClick={onRename}>
                <Pencil />
              </IconButton>
            )}
            <IconButton label="Delete" size="sm" tone="danger" onClick={onDelete}>
              <Trash2 />
            </IconButton>
          </span>
        )}
      </div>
    </li>
  )
}

function RenameInput({
  initial,
  onDone
}: {
  initial: string
  onDone: (title: string | null) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (title: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(title === null ? null : clampTitle(title))
  }
  return (
    <Input
      autoFocus
      value={value}
      maxLength={MAX_PAGE_TITLE_BYTES}
      className="h-7 min-w-0 flex-1 px-1 text-sm"
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
