/**
 * The end of a drag that closes a sheet or a drawer (spec §2.4, §2.5): past 35 % of the size, or a
 * flick faster than 0.5 px/ms. Else the surface snaps back. The sheet handle uses it now; the
 * drawer swipe (`lib/swipe.ts`) uses the same rule.
 */

/** A drag that ends past this share of the size commits. */
export const DRAG_COMMIT = 0.35
/** A drag that ends faster than this (px/ms, in the closing direction) commits too. */
export const DRAG_VELOCITY = 0.5
/** A lift this long (ms) after the last move is no flick. */
export const FLICK_GAP_MS = 100

export interface DragEnd {
  /** The distance (px) in the closing direction. */
  offset: number
  /** The size (px) of the surface along the drag. */
  size: number
  /** The speed (px/ms) in the closing direction at the last move. */
  velocity: number
  /** The time from the last move to the lift. */
  msSinceLastMove: number
}

export function shouldCommitDrag({ offset, size, velocity, msSinceLastMove }: DragEnd): boolean {
  // A finger that stopped before it lifted did not flick.
  const flick = msSinceLastMove > FLICK_GAP_MS ? 0 : velocity
  return offset > size * DRAG_COMMIT || flick > DRAG_VELOCITY
}
