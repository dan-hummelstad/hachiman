/** A stage tile: raised, hairline border, rounded 10 (18 on the phone). */
export const TILE =
  'bg-surface-raised border-line-hairline relative min-h-0 min-w-0 border rounded-[10px] mobile:rounded-[18px]'

/** The speaker: a 2 px live border (2.5 on the phone). No glow, no ring, no tint. */
export const TILE_SPEAKING = 'border-2 border-live mobile:border-[2.5px]'

/** The mono state line under a tile name ("SPEAKING", "MUTED"). */
export const STATE_LINE =
  'flex items-center gap-1.5 font-mono text-[9px] tracking-[1.3px] uppercase leading-3 text-text-disabled mobile:text-[7.5px] mobile:tracking-[1.2px] [&_svg]:size-[11px]'

/** The mono meta lines of a call ("NIGHT OWLS · 4 CONNECTED · 38 MS"). */
export const CALL_META = 'font-mono text-[9px] tracking-[0.8px] uppercase text-text-disabled'

/**
 * Columns of the stage grid for `count` tiles: 1, 2 (up to 4 tiles), 3 (up to 9), then 4.
 * Full literals so that Tailwind finds them.
 */
export function stageColumns(count: number): string {
  if (count <= 1) return 'grid-cols-1'
  if (count <= 4) return 'grid-cols-2'
  if (count <= 9) return 'grid-cols-3'
  return 'grid-cols-4'
}

/** The stage grid on the mobile layout (M10). */
export interface MobileStageGrid {
  /** One column for up to 2 tiles (one above the other), else 2. Never more on a phone. */
  columns: 1 | 2
  /** Up to 4 tiles share the height of the stage. Past 4 the tiles are square and scroll. */
  fill: boolean
  /** 3 tiles: the last one spans both columns, so no cell stays empty. */
  spanLast: boolean
}

export function mobileStageGrid(count: number): MobileStageGrid {
  return { columns: count <= 2 ? 1 : 2, fill: count <= 4, spanLast: count === 3 }
}
