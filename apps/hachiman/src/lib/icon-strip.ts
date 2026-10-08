/** How many items of `size` px, `gap` px apart, fit in one line of `width` px. */
export function stripSlots(width: number, size: number, gap: number): number {
  return Math.max(0, Math.floor((width + gap) / (size + gap)))
}

/**
 * The items of a one-line icon strip (the space bar, the favourite DMs) in `slots` places.
 * `tail`: a fixed last item (the space bar's "+") that shows only when everything fits. When the
 * items do not fit, the last place is the "more" item, and `selected` (when it is one of `ids`)
 * takes the last item place so that it stays in view.
 */
export function stripFit(
  ids: readonly string[],
  slots: number,
  selected: string | null | undefined,
  tail = false
): { shown: string[]; hidden: string[]; more: boolean } {
  if (ids.length + (tail ? 1 : 0) <= slots) return { shown: [...ids], hidden: [], more: false }
  const k = Math.max(0, slots - 1)
  let shown = ids.slice(0, k)
  if (k > 0 && selected != null && ids.includes(selected) && !shown.includes(selected)) {
    shown = [...ids.slice(0, k - 1), selected]
  }
  return { shown, hidden: ids.filter((id) => !shown.includes(id)), more: true }
}
