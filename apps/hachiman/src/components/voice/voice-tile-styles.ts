/** A stage tile: square, on the panel surface, with a hairline border. */
export const TILE = 'bg-surface-panel border-line-hairline relative min-h-0 min-w-0 border'

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
