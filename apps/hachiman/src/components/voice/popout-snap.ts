export type Corner = 'tl' | 'tr' | 'bl' | 'br'

/** How far ahead (ms) a throw carries the popout before it picks a corner. */
const THROW_MS = 220

/**
 * The corner a released popout sticks to: the one nearest to where its centre would land if the
 * throw (`vx`, `vy` in px/ms) carried on for a moment. `x`, `y` is its top-left in the viewport.
 */
export function snapCorner(
  x: number,
  y: number,
  vx: number,
  vy: number,
  size: { w: number; h: number },
  viewport: { w: number; h: number }
): Corner {
  const cx = x + size.w / 2 + vx * THROW_MS
  const cy = y + size.h / 2 + vy * THROW_MS
  const top = cy < viewport.h / 2
  const left = cx < viewport.w / 2
  return top ? (left ? 'tl' : 'tr') : left ? 'bl' : 'br'
}

/** The top-left of the popout parked in `corner`, `inset` px from the edges. */
export function cornerPoint(
  corner: Corner,
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  inset: { top: number; right: number; bottom: number; left: number }
): { x: number; y: number } {
  return {
    x: corner === 'tl' || corner === 'bl' ? inset.left : viewport.w - size.w - inset.right,
    y: corner === 'tl' || corner === 'tr' ? inset.top : viewport.h - size.h - inset.bottom
  }
}
