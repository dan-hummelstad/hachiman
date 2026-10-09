import type { Channel } from '@hachiman/client'

/** The tiles of a row of the sidebar top before the fifth place (the cluster tile). */
export const ROW_TILES = 4

/** The fill of a lit tile (E2): an opaque accent wash, so a presence cutout can match it. */
export const LIT_BG = 'bg-[color-mix(in_oklab,var(--accent-primary)_17%,var(--surface-raised))]'

/** The surface behind a tile's icon: the cutout of a presence dot on it. */
export const tileSurface = (lit: boolean): string => (lit ? LIT_BG : 'bg-surface-raised')

/**
 * The DM and group DM ids, most recent conversation first. `lastAt`: channel id → the time
 * (ms) of its newest message. A DM with no known message follows, in the order of `dms`.
 */
export function recentDms(dms: readonly Channel[], lastAt: ReadonlyMap<string, number>): string[] {
  return dms
    .map((c, i) => ({ id: c.id, at: lastAt.get(c.id) ?? -Infinity, i }))
    .sort((a, b) => b.at - a.at || a.i - b.i)
    .map((d) => d.id)
}

/** `ids` in the user's `order`; an id not in `order` (a guild joined since) follows in place. */
export function orderedIds(ids: readonly string[], order: readonly string[]): string[] {
  const known = new Set(ids)
  const first = order.filter((id) => known.has(id))
  const placed = new Set(first)
  return [...first, ...ids.filter((id) => !placed.has(id))]
}

/**
 * One row: the tiles, then the ids behind the cluster tile. `cluster` false: up to five ids show
 * as tiles and there is no cluster (a short guild list). True: the fifth place is always the
 * cluster (the DM row, whose cluster opens the DM home).
 */
export function rowSlice(
  ids: readonly string[],
  cluster: boolean
): { tiles: string[]; hidden: string[]; cluster: boolean } {
  if (!cluster && ids.length <= ROW_TILES + 1)
    return { tiles: [...ids], hidden: [], cluster: false }
  return { tiles: ids.slice(0, ROW_TILES), hidden: ids.slice(ROW_TILES), cluster: true }
}

/** `order` after a drag of `fromId` onto `toId`, or null when nothing moves. */
export function dragged(order: readonly string[], fromId: string, toId: string): string[] | null {
  const from = order.indexOf(fromId)
  const to = order.indexOf(toId)
  if (from < 0 || to < 0 || from === to) return null
  const out = [...order]
  out.splice(from, 1)
  out.splice(to, 0, fromId)
  return out
}
