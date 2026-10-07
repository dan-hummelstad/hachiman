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
