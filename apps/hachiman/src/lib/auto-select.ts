/**
 * Marks a selection that the app makes by itself, not the user: the shell's pick of a guild's
 * first text channel (`useDefaultChannel`). The mobile drawer close rule (`lib/mobile-drawer.ts`)
 * keeps the sidebar open on such a pick. The stores notify their subscribers synchronously, so
 * the mark covers every notification of the selection.
 */
let auto = false

export function autoSelect(select: () => void): void {
  auto = true
  try {
    select()
  } finally {
    auto = false
  }
}

/** True while `autoSelect` runs. */
export const isAutoSelect = (): boolean => auto
