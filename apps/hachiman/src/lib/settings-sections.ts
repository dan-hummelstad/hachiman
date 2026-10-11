/** A row of the settings list. A hidden row (`visible: false`) is left out. */
export interface SectionLike {
  id: string
  /** Default true. */
  visible?: boolean
}

export const isVisible = (s: SectionLike): boolean => s.visible !== false

/** The visible row `picked`, else the first visible row; undefined when no row shows. */
export function resolveSection<T extends SectionLike>(
  groups: readonly { items: readonly T[] }[],
  picked: string | null
): T | undefined {
  const visible = groups.flatMap((g) => g.items).filter(isVisible)
  return visible.find((s) => s.id === picked) ?? visible[0]
}

/** A row that can push a page of its own (the mobile settings list). */
export interface PagedSectionLike extends SectionLike {
  /** Absent: the row has no page to push. */
  page?: unknown
}

/**
 * The section whose page the mobile settings list pushes: `section` when it is a visible row with
 * a page and not the `inline` one. Else null, and the list shows (a hidden, unknown or inline
 * section, or a row without a page).
 */
export function listedPageId(
  groups: readonly { items: readonly PagedSectionLike[] }[],
  section: string | null,
  inline: string | undefined
): string | null {
  if (section === null || section === inline) return null
  const item = groups.flatMap((g) => g.items).find((s) => s.id === section)
  return item && isVisible(item) && item.page ? section : null
}

/**
 * The groups of the mobile settings list: the visible rows without the `inline` one, which shows
 * above the groups. A group that is left with no rows is left out.
 */
export function listedGroups<G extends { items: readonly SectionLike[] }>(
  groups: readonly G[],
  inline: string | undefined
): (Omit<G, 'items'> & { items: G['items'][number][] })[] {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((s) => isVisible(s) && s.id !== inline) }))
    .filter((g) => g.items.length > 0)
}
