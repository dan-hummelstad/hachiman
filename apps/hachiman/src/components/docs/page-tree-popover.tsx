import { useMemo, useState } from 'react'
import { FilePlus, FileText, GripVertical, ListTree, Pencil, Plus, Trash2 } from 'lucide-react'
import { DndContext, closestCenter } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import {
  PageDeleteConfirm,
  PageMoveConfirm,
  RenameInput
} from '@/components/docs/page-tree-actions'
import {
  INDENT,
  usePageTreeActions,
  type PageTreeActions
} from '@/components/docs/use-page-tree-actions'
import { ErrorText } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useDragSensors, useSortableRow } from '@/hooks/use-sortable-row'
import { cn } from '@/lib/utils'
import type { PageNode } from '@/stores/docsStore'
import { flattenPages, pageTitle, type FlatPage } from '@/services/docs/page-tree'

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
  const actions = usePageTreeActions(channelId, pages)
  // A drag starts after 4 px, so a click is not a drag.
  const sensors = useDragSensors()

  const create = async (parentId: string | null): Promise<void> => {
    const id = await actions.create(parentId)
    if (id !== null) actions.setRenaming(id)
  }

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
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={actions.onDragEnd}
      >
        <SortableContext items={rows.map((r) => r.page.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex max-h-96 flex-col gap-px overflow-y-auto">
            {rows.map((row) => (
              <TreeRow
                key={row.page.id}
                row={row}
                actions={actions}
                selected={row.page.id === openPageId}
                canEdit={canEdit}
                onOpen={() => onOpen(row.page.id)}
                onAddChild={() => void create(row.page.id)}
              />
            ))}
            {rows.length === 0 && (
              <li className="text-muted-foreground px-2 py-1.5 text-sm">No pages yet.</li>
            )}
          </ul>
        </SortableContext>
      </DndContext>
      <ErrorText>{actions.error}</ErrorText>
      <PageMoveConfirm actions={actions} />
      <PageDeleteConfirm
        pages={pages}
        page={actions.deleting}
        onClose={() => actions.setDeleting(null)}
      />
    </div>
  )
}

/** One row of the popover tree: a grip to drag and the actions on hover. */
function TreeRow({
  row,
  actions,
  selected,
  canEdit,
  onOpen,
  onAddChild
}: {
  row: FlatPage
  actions: PageTreeActions
  selected: boolean
  canEdit: boolean
  onOpen: () => void
  onAddChild: () => void
}): React.JSX.Element {
  const { page, depth } = row
  const renaming = actions.renaming === page.id
  const { setNodeRef, attributes, listeners, style } = useSortableRow({
    id: page.id,
    disabled: !canEdit || renaming
  })

  return (
    <li ref={setNodeRef} style={{ ...style, paddingLeft: depth * INDENT }}>
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
          <RenameInput
            initial={page.title}
            onDone={(title) => actions.finishRename(page, title)}
            className="h-7 min-w-0 flex-1 px-1 text-sm"
          />
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
              <IconButton label="Rename" size="sm" onClick={() => actions.setRenaming(page.id)}>
                <Pencil />
              </IconButton>
            )}
            <IconButton
              label="Delete"
              size="sm"
              tone="danger"
              onClick={() => actions.setDeleting(page)}
            >
              <Trash2 />
            </IconButton>
          </span>
        )}
      </div>
    </li>
  )
}
