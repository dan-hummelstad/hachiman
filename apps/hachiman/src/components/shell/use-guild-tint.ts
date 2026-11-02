/** CSS variables for the wallpaper (a background image) of the shell root, per theme. */
export type WallpaperVars = { '--wallpaper-light': string; '--wallpaper-dark': string }

/** A colour per theme (any CSS colour). */
export type ThemeColors = { light: string; dark: string }

export interface GuildTint {
  /** The style of the shell root. */
  vars: WallpaperVars
  /**
   * The solid colour at the top of the window (behind the status bar on a phone), for
   * `useNativeAppearance`.
   */
  window: ThemeColors
}

const FLAT: GuildTint = {
  vars: { '--wallpaper-light': 'none', '--wallpaper-dark': 'none' },
  window: { light: 'var(--surface-panel)', dark: 'var(--surface-panel)' }
}

/**
 * The window has no wallpaper: the surfaces are flat and the theme sets them. Kept as a hook so
 * the callers and the guild argument stay as they were.
 */
export function useGuildTint(_guildId: string | null): GuildTint {
  return FLAT
}
