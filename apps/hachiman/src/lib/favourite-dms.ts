import type { Channel } from '@hachiman/client'

/**
 * The favourite DM tiles (N6), in the user's order: the ids that still name a DM or group DM I
 * have. A favourite of a closed or unknown DM stays in the prefs and shows again when it is back.
 */
export function favouriteTiles(
  favouriteIds: readonly string[],
  channels: ReadonlyMap<string, Channel>
): Channel[] {
  const out: Channel[] = []
  for (const id of favouriteIds) {
    const c = channels.get(id)
    if (c && c.guildId === null && !out.includes(c)) out.push(c)
  }
  return out
}

/**
 * A drag from tile `fromId` onto tile `toId`, as indexes into the stored favourites list (which
 * can hold ids that have no tile). Null when either id is not in the list or nothing moves.
 */
export function favouriteMove(
  favouriteIds: readonly string[],
  fromId: string,
  toId: string
): { from: number; to: number } | null {
  const from = favouriteIds.indexOf(fromId)
  const to = favouriteIds.indexOf(toId)
  if (from < 0 || to < 0 || from === to) return null
  return { from, to }
}
