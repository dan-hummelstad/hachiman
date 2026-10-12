import { useEffect, useState } from 'react'
import {
  customWallpaper,
  customWindowColor,
  decodeIconHue,
  fallbackHue,
  HOME_TINT,
  HOME_WALLPAPER,
  tintColors,
  tintWallpaper
} from '@/lib/guild-tint'
import { hachiman } from '@/services/hachiman'
import { useGuildStore } from '@/stores/guildStore'
import { usePrefsStore } from '@/stores/prefsStore'

/** Icon key → decoded hue (null = no saturated pixel or no load). Icons are plaintext files. */
const decoded = new Map<string, number | null>()
const inFlight = new Set<string>()

/** CSS variables for the wallpaper (a background image) of the shell root (N4), per theme. */
export type WallpaperVars = { '--wallpaper-light': string; '--wallpaper-dark': string }

/** A colour per theme (any CSS colour). */
export type ThemeColors = { light: string; dark: string }

export interface GuildTint {
  /** The style of the shell root. */
  vars: WallpaperVars
  /**
   * The solid colour at the top of the wallpaper (behind the status bar on a phone), for
   * `useNativeAppearance`.
   */
  window: ThemeColors
}

const HOME: GuildTint = {
  vars: { '--wallpaper-light': HOME_WALLPAPER, '--wallpaper-dark': HOME_WALLPAPER },
  window: { light: HOME_TINT, dark: HOME_TINT }
}

/**
 * The window wallpaper. By default the guild tints it: the dominant hue of its icon, else a hash
 * of its id; the DM space (null) uses `--tint-home`. The user's custom gradient (prefs) replaces
 * it everywhere.
 */
export function useGuildTint(guildId: string | null): GuildTint {
  const mode = usePrefsStore((s) => s.wallpaper)
  const gradient = usePrefsStore((s) => s.customGradient)
  const icon = useGuildStore((s) => (guildId ? (s.guilds.get(guildId)?.icon ?? null) : null))
  const [, setVersion] = useState(0)

  useEffect(() => {
    if (!icon || decoded.has(icon) || inFlight.has(icon)) return
    inFlight.add(icon)
    void decodeIconHue(hachiman.rest.fileUrl(icon)).then((hue) => {
      inFlight.delete(icon)
      decoded.set(icon, hue)
      setVersion((v) => v + 1)
    })
  }, [icon])

  if (mode === 'custom') {
    const custom = customWallpaper(gradient)
    const top = customWindowColor(gradient)
    return {
      vars: { '--wallpaper-light': custom, '--wallpaper-dark': custom },
      window: { light: top, dark: top }
    }
  }
  if (!guildId) return HOME
  const hue = (icon ? decoded.get(icon) : null) ?? fallbackHue(guildId)
  const colors = tintColors(hue)
  return {
    vars: {
      '--wallpaper-light': tintWallpaper(colors.light),
      '--wallpaper-dark': tintWallpaper(colors.dark)
    },
    window: colors
  }
}
