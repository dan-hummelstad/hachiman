import { useState } from 'react'
import { ChevronUp, Plus } from 'lucide-react'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { TOUCH_HIT } from '@/components/sidebar/sidebar-row'
import { IconButton } from '@/components/ui/icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useLayout } from '@/hooks/use-layout'
import { SORTABLE_TOUCH, useDragSensors, useSortableRow } from '@/hooks/use-sortable-row'
import type { UnreadBadge } from '@/lib/notify'
import { LIT_BG, ROW_TILES, tileSurface } from '@/lib/sidebar-tiles'
import { STACK_W, cutStyle, stackHoles, tileMark, type Hole } from '@/lib/tile-cutouts'
import { cn } from '@/lib/utils'

const COLUMNS = ROW_TILES + 1

/**
 * On the mobile layout a tile is a translucent fill (it takes the drawer tint, M3, M12), and the
 * rings around its marks are holes in the icons under them (`lib/tile-cutouts.ts`): each
 * `[data-slot=avatar]` in the tile takes the mask in `--cut`.
 */
const TILE = cn(
  'relative flex h-[46px] w-full items-center justify-center rounded-[8px] border',
  'mobile:[&_[data-slot=avatar]]:[mask-image:var(--cut,none)] mobile:[&_[data-slot=avatar]]:[mask-composite:intersect]'
)
const tileClass = (lit: boolean, held = false): string =>
  cn(
    TILE,
    'transition-colors',
    lit
      ? cn(LIT_BG, 'border-accent-primary/40 mobile:bg-accent-primary/17')
      : 'bg-surface-raised hover:bg-surface-hover mobile:bg-surface-hover border-transparent',
    held && 'mobile:bg-fill-control-strong'
  )

/**
 * One row of the sidebar top (docs/ui-redesign.md §7): a small header with "+", then five
 * places a row. `ids` are the tiles; the cluster tile takes the fifth place, so with more than
 * four `ids` (the open guild grid) it ends the first line and the rest follow, five a line.
 * Arrow keys move the focus (up and down by a line). `onMove`: drag a tile onto another to
 * reorder (on a phone: hold it, then move). `onEscape`: Escape inside the row (the open grid
 * folds).
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
          className={cn('text-text-tertiary rounded-control h-5 w-[22px]', TOUCH_HIT)}
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
 * On the mobile layout a finger that holds the tile shows its name above it (the tooltip, which
 * touch otherwise never shows) until it lifts.
 */
export function Tile({
  id,
  label,
  lit,
  onClick,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'button'>, 'id'> & {
  id: string
  label: string
  lit: boolean
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const { setNodeRef, attributes, listeners, isDragging, style } = useSortableRow({
    id,
    // A held tile stays solid under the finger.
    dim: !mobile
  })
  const held = mobile && isDragging
  const [hover, setHover] = useState(false)
  return (
    <li ref={setNodeRef} style={style}>
      <Tooltip open={held || hover} onOpenChange={setHover}>
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
            className={cn(tileClass(lit, held), SORTABLE_TOUCH, className)}
          >
            {children}
          </button>
        </TooltipTrigger>
        {held ? (
          // M3: the name bubble above the held tile, clear of the finger; it follows the tile.
          <TooltipContent
            side="top"
            updatePositionStrategy="always"
            className="mobile:pointer-coarse:block px-2.5 py-1.5 text-[12.5px] font-bold"
          >
            {label}
          </TooltipContent>
        ) : (
          <TooltipContent side="bottom">{label}</TooltipContent>
        )}
      </Tooltip>
    </li>
  )
}

/**
 * The fifth place of a TileRow: up to three small icons of the ids it holds, stacked, with their
 * badge together. `expanded` (the guild grid): a chevron that folds the grid back. On the mobile
 * layout the badge sits on the stack's corner, as on the other tiles.
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
  fallback?: React.ReactNode
}): React.JSX.Element {
  const mark = tileMark(badge, STACK_W, { dot: false })
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
              // Desktop: the badge is on the tile's corner (this span is not positioned).
              <span className="mobile:relative flex">
                <Stack items={stack} fallback={fallback} lit={lit} cut={mark.holes} />
                <UnreadMark
                  badge={badge}
                  size="corner"
                  dot={false}
                  className={cn('top-1 right-1', mark.className)}
                />
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </li>
  )
}

/**
 * Where the stacked icons sit in the 34x30 box, by count: two behind, the last in front. The
 * holes on a phone use the same places (`STACK_XY` in `lib/tile-cutouts.ts`).
 */
const STACK_AT = [
  [],
  ['left-1/2 top-1/2 -translate-1/2'],
  ['left-0 top-0', 'right-0 bottom-0'],
  ['left-0 top-0', 'right-0 top-0', 'left-1/2 bottom-0 -translate-x-1/2']
]

function Stack({
  items,
  fallback,
  lit,
  cut
}: {
  items: React.ReactNode[]
  fallback?: React.ReactNode
  lit: boolean
  /** The holes of the cluster badge, in the stack's box. */
  cut: readonly Hole[]
}): React.JSX.Element {
  const shown = items.slice(0, 3)
  if (shown.length === 0) return <>{fallback}</>
  return (
    <span aria-hidden className="relative block h-[30px] w-[34px]">
      {shown.map((item, i) => (
        <span
          key={i}
          style={cutStyle(stackHoles(shown.length, i, cut))}
          className={cn(
            'absolute flex size-[20px] rounded-full p-px',
            tileSurface(lit),
            'mobile:bg-transparent',
            STACK_AT[shown.length][i]
          )}
        >
          {item}
        </span>
      ))}
    </span>
  )
}
