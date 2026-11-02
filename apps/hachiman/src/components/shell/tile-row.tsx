import { useState } from 'react'
import { ChevronUp, Plus } from 'lucide-react'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { TOUCH_HIT } from '@/lib/touch'
import { IconButton } from '@/components/ui/icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useLayout } from '@/hooks/use-layout'
import { SORTABLE_TOUCH, useDragSensors, useSortableRow } from '@/hooks/use-sortable-row'
import type { UnreadBadge } from '@/lib/notify'
import { ROW_TILES, tileSurface } from '@/lib/sidebar-tiles'
import { STACK_W, cutStyle, stackHoles, tileMark, type Hole } from '@/lib/tile-cutouts'
import { cn } from '@/lib/utils'

const COLUMNS = ROW_TILES + 1

/** The lit "+" of a row (M44): a `live` tile with a `live` mark. Mobile layout only. */
const ADD_LIT = 'mobile:border mobile:border-live-line mobile:bg-live-tint mobile:text-live-text'

/**
 * On the mobile layout a tile is a translucent fill (it takes the drawer tint, M3, M12), and the
 * rings around its marks are holes in the icons under them (`lib/tile-cutouts.ts`): each
 * `[data-slot=avatar]` in the tile takes the mask in `--cut`.
 */
const TILE = cn(
  'rounded-option relative flex h-11 w-full items-center justify-center border mobile:h-[50px] mobile:rounded-[14px]',
  'mobile:[&_[data-slot=avatar]]:[mask-image:var(--cut,none)] mobile:[&_[data-slot=avatar]]:[mask-composite:intersect]'
)
/**
 * The lit tile of a space (`here`): the accent fill with a 1.5px accent border; on the mobile
 * layout a tint with a 2px accent border. An idle tile is a neutral avatar shade.
 */
const tileClass = (lit: boolean, held = false): string =>
  cn(
    TILE,
    'transition-colors',
    lit
      ? 'bg-here border-here text-on-here border-[1.5px] mobile:border-2 mobile:bg-here-tint mobile:text-here-text'
      : 'bg-avatar-1 text-text-tertiary hover:bg-avatar-2 mobile:bg-surface-raised border-transparent',
    held && 'mobile:bg-surface-selected'
  )

/**
 * The space tiles of the sidebar top: a small header with "+", then five
 * places a row. `ids` are the tiles; the cluster tile takes the fifth place, so with more than
 * four `ids` (the open guild grid) it ends the first line and the rest follow, five a line.
 * Arrow keys move the focus (up and down by a line). `onMove`: drag a tile onto another to
 * reorder (on a phone: hold it, then move). `onEscape`: Escape inside the row (the open grid
 * folds). `addLit`: the sheet that "+" opens is open; on the mobile layout the "+" stays lit
 * under the dim (M44).
 */
export function TileRow({
  label,
  add,
  addLit = false,
  ids,
  renderTile,
  cluster,
  onMove,
  onEscape
}: {
  label: string
  add: { label: string; onClick: () => void }
  addLit?: boolean
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
    <section aria-label={label} className="flex flex-col">
      <div className="flex h-[26px] items-center px-3">
        <h2 className="cap flex-1">{label}</h2>
        <IconButton
          size="sm"
          label={add.label}
          onClick={add.onClick}
          className={cn('text-text-disabled rounded-control h-5 w-[22px]', TOUCH_HIT, addLit && ADD_LIT)}
        >
          <Plus className="size-[13px]" />
        </IconButton>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={[...ids]} strategy={rectSortingStrategy} disabled={!onMove}>
          <ul onKeyDown={onKeyDown} className="grid grid-cols-5 gap-2 px-3 pt-1">
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
            className="mobile:pointer-coarse:block px-2.5 py-1.5 text-[12.5px] font-semibold"
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
  stack = [],
  fallback,
  count
}: {
  label: string
  lit: boolean
  badge: UnreadBadge
  /** Undefined: the tile does not expand anything. */
  expanded?: boolean
  onClick: () => void
  /** Up to three 18px icons of the ids behind the tile. */
  stack?: React.ReactNode[]
  fallback?: React.ReactNode
  /** Shows "+N" in place of the stack (the overflow tile). */
  count?: number
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
            className={cn(
              tileClass(lit),
              count !== undefined && !lit && 'border-line-strong bg-transparent hover:bg-surface-hover border'
            )}
          >
            {expanded ? (
              <ChevronUp className="size-4" />
            ) : (
              // Desktop: the badge is on the tile's corner (this span is not positioned).
              <span className="mobile:relative flex">
                {count !== undefined ? (
                  <span className="font-mono text-[11px]">+{count}</span>
                ) : (
                  <Stack items={stack} fallback={fallback} lit={lit} cut={mark.holes} />
                )}
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
