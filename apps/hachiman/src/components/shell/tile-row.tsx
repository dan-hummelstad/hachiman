import { ChevronUp, Plus } from 'lucide-react'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { IconButton } from '@/components/ui/icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useDragSensors, useSortableRow } from '@/hooks/use-sortable-row'
import type { UnreadBadge } from '@/lib/notify'
import { LIT_BG, ROW_TILES, tileSurface } from '@/lib/sidebar-tiles'
import { cn } from '@/lib/utils'

const COLUMNS = ROW_TILES + 1

const TILE = 'relative flex h-[46px] w-full items-center justify-center rounded-[8px] border'
const tileClass = (lit: boolean): string =>
  cn(
    TILE,
    'transition-colors',
    lit
      ? cn(LIT_BG, 'border-accent-primary/40')
      : 'bg-surface-raised hover:bg-surface-hover border-transparent'
  )

/**
 * One row of the sidebar top (docs/ui-redesign.md §7): a small header with "+", then five
 * places a row. `ids` are the tiles; the cluster tile takes the fifth place, so with more than
 * four `ids` (the open guild grid) it ends the first line and the rest follow, five a line.
 * Arrow keys move the focus (up and down by a line). `onMove`: drag a tile onto another to
 * reorder. `onEscape`: Escape inside the row (the open grid folds).
 */
export function TileRow({
  label,
  add,
  ids,
  renderTile,
  cluster,
  onMove,
  onEscape
}: {
  label: string
  add: { label: string; onClick: () => void }
  ids: readonly string[]
  renderTile: (id: string) => React.ReactNode
  cluster: React.ReactNode
  onMove?: (fromId: string, toId: string) => void
  onEscape?: () => void
}): React.JSX.Element {
  const sensors = useDragSensors()
  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (over && active.id !== over.id) onMove?.(String(active.id), String(over.id))
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>): void => {
    if (e.key === 'Escape' && onEscape) {
      e.preventDefault()
      onEscape()
      e.currentTarget.querySelector<HTMLElement>('[data-cluster]')?.focus()
      return
    }
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-tile]')]
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -COLUMNS,
      ArrowDown: COLUMNS,
      Home: -at,
      End: items.length - 1 - at
    }
    const d = step[e.key]
    if (d === undefined) return
    e.preventDefault()
    items[Math.min(items.length - 1, Math.max(0, at + d))]?.focus()
  }

  return (
    <section aria-label={label} className="flex flex-col gap-1.5">
      <div className="flex h-5 items-center pl-1">
        <h2 className="section-label flex-1 text-[11px]">{label}</h2>
        <IconButton
          size="sm"
          label={add.label}
          onClick={add.onClick}
          className="text-text-tertiary rounded-control h-5 w-[22px]"
        >
          <Plus />
        </IconButton>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={[...ids]} strategy={rectSortingStrategy} disabled={!onMove}>
          {/* An avatar initial gets a lighter fill than the tile, so its disc shows. */}
          <ul
            onKeyDown={onKeyDown}
            className="grid grid-cols-5 gap-1.5 [&_[data-slot=avatar-fallback]]:bg-surface-hover"
          >
            {ids.slice(0, ROW_TILES).map(renderTile)}
            {cluster}
            {ids.slice(ROW_TILES).map(renderTile)}
          </ul>
        </SortableContext>
      </DndContext>
    </section>
  )
}

/**
 * One tile of a TileRow: a 46 high button with a tooltip, lit while `lit`. Sortable when the
 * row has `onMove`. Extra props (from a wrapping `ContextMenuTrigger asChild`) land on the button.
 */
export function Tile({
  id,
  label,
  lit,
  onClick,
  children,
  ...props
}: Omit<React.ComponentProps<'button'>, 'id'> & {
  id: string
  label: string
  lit: boolean
}): React.JSX.Element {
  const { setNodeRef, attributes, listeners, style } = useSortableRow({ id })
  return (
    <li ref={setNodeRef} style={style}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            {...attributes}
            {...listeners}
            {...props}
            data-tile=""
            aria-label={label}
            aria-current={lit ? 'page' : undefined}
            onClick={onClick}
            className={tileClass(lit)}
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </li>
  )
}

/**
 * The fifth place of a TileRow: up to three small icons of the ids it holds, stacked, with their
 * badge together. `expanded` (the guild grid): a chevron that folds the grid back.
 */
export function ClusterTile({
  label,
  lit,
  badge,
  expanded,
  onClick,
  stack,
  fallback
}: {
  label: string
  lit: boolean
  badge: UnreadBadge
  /** Undefined: the tile does not expand anything. */
  expanded?: boolean
  onClick: () => void
  /** Up to three 18px icons of the ids behind the tile. */
  stack: React.ReactNode[]
  /** Shown when `stack` is empty. */
  fallback?: React.ReactNode
}): React.JSX.Element {
  return (
    <li>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-tile=""
            data-cluster=""
            aria-label={label}
            aria-expanded={expanded}
            aria-current={lit ? 'page' : undefined}
            onClick={onClick}
            className={cn(tileClass(lit), 'text-text-secondary')}
          >
            {expanded ? (
              <ChevronUp className="size-4" />
            ) : (
              <Stack items={stack} fallback={fallback} lit={lit} />
            )}
            {!expanded && (
              <UnreadMark badge={badge} size="corner" dot={false} className="top-1 right-1" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </li>
  )
}

/** Where the stacked icons sit in the 34x30 box, by count: two behind, the last in front. */
const STACK_AT = [
  [],
  ['left-1/2 top-1/2 -translate-1/2'],
  ['left-0 top-0', 'right-0 bottom-0'],
  ['left-0 top-0', 'right-0 top-0', 'left-1/2 bottom-0 -translate-x-1/2']
]

function Stack({
  items,
  fallback,
  lit
}: {
  items: React.ReactNode[]
  fallback?: React.ReactNode
  lit: boolean
}): React.JSX.Element {
  const shown = items.slice(0, 3)
  if (shown.length === 0) return <>{fallback}</>
  return (
    <span aria-hidden className="relative block h-[30px] w-[34px]">
      {shown.map((item, i) => (
        <span
          key={i}
          className={cn(
            'absolute flex size-[20px] rounded-full p-px',
            tileSurface(lit),
            STACK_AT[shown.length][i]
          )}
        >
          {item}
        </span>
      ))}
    </span>
  )
}
