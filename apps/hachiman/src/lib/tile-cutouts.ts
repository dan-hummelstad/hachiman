import type { UnreadBadge } from '@/lib/notify'
import { unreadMarkOf } from '@/lib/unread-mark'
import { cn } from '@/lib/utils'

/**
 * Cutouts of the sidebar tiles on the mobile layout (docs/ios-mobile-ui-spec.md A5, M3, M12).
 * The drawer is a tinted wallpaper, and a tile there is a translucent fill over it, so the tile
 * takes the tint. A ring painted in a surface colour around a mark (the presence dot, an unread
 * mark, a stacked icon) would then show as a pale or dark halo. So on a phone a ring is a hole:
 * the icon under the mark gets a CSS mask with round holes, and the tile shows through, whatever
 * the tint (transparent-safe). The holes go in `--cut` on an ancestor of the icon, and the tile
 * (`components/shell/tile-row.tsx`) masks each `[data-slot=avatar]` in it with that variable.
 * Desktop keeps its opaque tiles and painted rings.
 */

/** A round hole in an icon: centre x, y and radius, in px of the icon's box. */
export type Hole = readonly [x: number, y: number, r: number]

/** The ring between a mark and the icon under it. */
export const RING = 2
/** The corner count pill of `UnreadMark size="corner"` is 15 high; the corner dot is 7. */
const PILL_H = 15
const DOT = 7
/** Pill holes are circles at most this far apart, so their union has straight sides. */
const PILL_STEP = 3

/** The value of `--cut`: the holes with a 0.5 px soft edge, or `none`. */
export function cutMask(holes: readonly Hole[]): string {
  if (holes.length === 0) return 'none'
  return holes
    .map(([x, y, r]) => `radial-gradient(circle at ${x}px ${y}px, #0000 ${r}px, #000 ${r + 0.5}px)`)
    .join(', ')
}

/** The style that hands `holes` to the icons inside an element (`--cut`). */
export const cutStyle = (holes: readonly Hole[]): React.CSSProperties =>
  ({ '--cut': cutMask(holes) }) as React.CSSProperties

/** `holes` in the box of an icon whose top-left corner is at (x, y). */
export const shiftHoles = (holes: readonly Hole[], x: number, y: number): Hole[] =>
  holes.map(([hx, hy, r]) => [hx - x, hy - y, r])

/**
 * The holes for a pill `h` high from `x0` to `x1` with its centre line at `cy`, grown by the
 * ring: a row of circles along the centre line.
 */
export function pillHoles(x0: number, x1: number, cy: number, h: number = PILL_H): Hole[] {
  const r = h / 2
  const from = x0 + r
  const to = Math.max(from, x1 - r)
  const steps = Math.ceil((to - from) / PILL_STEP)
  return Array.from({ length: steps + 1 }, (_, i): Hole => [
    steps === 0 ? from : from + ((to - from) * i) / steps,
    cy,
    r + RING
  ])
}

/** The mobile width of a count pill by the length of its label ("99+" at most), so its hole fits. */
const PILL_W: Record<number, { px: number; className: string }> = {
  1: { px: 15, className: 'mobile:w-[15px]' },
  2: { px: 19, className: 'mobile:w-[19px]' },
  3: { px: 24, className: 'mobile:w-6' }
}

/**
 * The corner unread mark of a tile icon `box` px wide, on the mobile layout: a count pill at
 * -6 / -8 (top / right, as M3 draws it), or the unread dot at -2 / -2, with no ring. `className`
 * gives the mark these mobile classes (the caller keeps its desktop place); `holes` cut its ring
 * out of the icon under it (in the box of the icon). Nothing to cut when there is no mark.
 */
export function tileMark(
  badge: UnreadBadge,
  box: number,
  { dot = true }: { dot?: boolean } = {}
): { className: string; holes: Hole[] } {
  const mark = unreadMarkOf(badge, { dot })
  if (!mark) return { className: '', holes: [] }
  if (mark.kind === 'count') {
    const w = PILL_W[mark.label.length] ?? PILL_W[3]
    const right = box + 8
    return {
      className: cn('mobile:-top-1.5 mobile:-right-2 mobile:ring-0', w.className),
      holes: pillHoles(right - w.px, right, -6 + PILL_H / 2)
    }
  }
  return {
    className: 'mobile:-top-0.5 mobile:-right-0.5 mobile:ring-0',
    holes: [[box + 2 - DOT / 2, -2 + DOT / 2, DOT / 2 + RING]]
  }
}

/** The stack of the cluster tile: a 34 x 30 box of 20 px icons (an 18 px icon in a 1 px ring). */
export const STACK_W = 34
const STACK_ITEM = 20

/**
 * The top-left corner (px) of each stacked icon by count, two behind and the last in front. The
 * same places as the `STACK_AT` classes in `components/shell/tile-row.tsx`.
 */
const STACK_XY: readonly (readonly (readonly [number, number])[])[] = [
  [],
  [[7, 5]],
  [
    [0, 0],
    [14, 10]
  ],
  [
    [0, 0],
    [14, 0],
    [7, 10]
  ]
]

/**
 * The holes of stacked icon `i` of `n`, in its 18 px icon: the icons in front of it, and `badge`
 * (the holes of the cluster's unread mark, in the stack's box).
 */
export function stackHoles(n: number, i: number, badge: readonly Hole[]): Hole[] {
  const at = STACK_XY[n] ?? []
  const [x, y] = at[i] ?? [0, 0]
  const front = at
    .slice(i + 1)
    .map(([fx, fy]): Hole => [fx + STACK_ITEM / 2, fy + STACK_ITEM / 2, STACK_ITEM / 2])
  return shiftHoles([...front, ...badge], x + 1, y + 1)
}
