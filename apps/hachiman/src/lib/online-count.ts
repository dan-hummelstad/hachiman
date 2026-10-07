/** How many of `ids` have a presence that is not offline, leaving out `except` (me). */
export function countOnline(
  ids: Iterable<string>,
  presences: ReadonlyMap<string, string>,
  except?: string
): number {
  let n = 0
  for (const id of ids) {
    if (id === except) continue
    const p = presences.get(id)
    if (p && p !== 'offline') n++
  }
  return n
}
