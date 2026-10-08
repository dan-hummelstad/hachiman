import { useEffect, useState } from 'react'
import {
  customWallpaper,
  decodeIconHue,
  fallbackHue,
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

const HOME_WALLPAPER = tintWallpaper('var(--tint-home)')
const HOME: WallpaperVars = {
  '--wallpaper-light': HOME_WALLPAPER,
  '--wallpaper-dark': HOME_WALLPAPER
}

/**
 * The window wallpaper. By default the guild tints it: the dominant hue of its icon, else a hash
 * of its id; the DM space (null) uses `--tint-home`. The user's custom gradient (prefs) replaces
 * it everywhere.
 */
export function useGuildTint(guildId: string | null): WallpaperVars {
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
    return { '--wallpaper-light': custom, '--wallpaper-dark': custom }
  }
  if (!guildId) return HOME
  const hue = (icon ? decoded.get(icon) : null) ?? fallbackHue(guildId)
  const { light, dark } = tintColors(hue)
  return { '--wallpaper-light': tintWallpaper(light), '--wallpaper-dark': tintWallpaper(dark) }
}
