import { useEffect, useState } from 'react'
import { decodeIconHue, fallbackHue, tintColors } from '@/lib/guild-tint'
import { hachiman } from '@/services/hachiman'
import { useGuildStore } from '@/stores/guildStore'

/** Icon key → decoded hue (null = no saturated pixel or no load). Icons are plaintext files. */
const decoded = new Map<string, number | null>()
const inFlight = new Set<string>()

/** CSS variables for the wallpaper of the shell root (N4). The DM space (null) uses `--tint-home`. */
export type TintVars = { '--tint-light': string; '--tint-dark': string }

const HOME: TintVars = { '--tint-light': 'var(--tint-home)', '--tint-dark': 'var(--tint-home)' }

/** The wallpaper tint of a guild: the dominant hue of its icon, else a hash of its id. */
export function useGuildTint(guildId: string | null): TintVars {
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

  if (!guildId) return HOME
  const hue = (icon ? decoded.get(icon) : null) ?? fallbackHue(guildId)
  const { light, dark } = tintColors(hue)
  return { '--tint-light': light, '--tint-dark': dark }
}
