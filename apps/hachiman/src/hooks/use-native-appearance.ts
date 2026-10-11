import { useEffect, useId } from 'react'

import { useMediaQuery } from '@/hooks/use-media-query'
import { resolveCssColor } from '@/lib/css-color'
import { DARK_QUERY, type ResolvedTheme, resolveTheme } from '@/lib/theme'
import type { IPlatformService } from '@/shared/IPlatformService'
import { usePlatform } from '@/shared/PlatformContext'
import { usePrefsStore } from '@/stores/prefsStore'

/** The window colour of the sign-in and gate screens. */
export const DEFAULT_WINDOW_COLOR = 'var(--surface-window)'

/** The theme that ThemeProvider puts on `<html>`. */
function useResolvedTheme(): ResolvedTheme {
  const pref = usePrefsStore((s) => s.theme)
  const osDark = useMediaQuery(DARK_QUERY)
  return resolveTheme(pref, osDark)
}

interface Request {
  background: string
  base: boolean
}

/** The mounted callers, in mount order. */
const requests = new Map<string, Request>()
let last: { platform: IPlatformService; theme: ResolvedTheme } | null = null
let sent: string | null = null

/** The last caller that is not the base wins, else the base. */
export function pickRequest<T extends Request>(inOrder: readonly T[]): T | null {
  let base: T | null = null
  for (let i = inOrder.length - 1; i >= 0; i--) {
    const r = inOrder[i]
    if (!r) continue
    if (!r.base) return r
    base ??= r
  }
  return base
}

function flush(): void {
  if (!last) return
  const winner = pickRequest([...requests.values()])
  if (!winner) return
  const { platform, theme } = last
  const background = resolveCssColor(winner.background, theme)
  if (!background) return
  const key = `${theme} ${background}`
  if (key === sent) return
  sent = key
  platform.setAppearance({ theme, background })
}

/**
 * The native status bar style and the window colour behind the safe areas follow the app theme
 * and `background` (any CSS colour). The host gets a call only when the resolved theme or the
 * colour changes. `App.tsx` mounts the base (the default window colour). A screen that shows a
 * tinted window (the mobile shell) passes its colour, and the latest such caller wins while it
 * is mounted.
 */
export function useNativeAppearance(background: string, { base = false } = {}): void {
  const platform = usePlatform()
  const theme = useResolvedTheme()
  const id = useId()

  useEffect(() => {
    requests.set(id, { background, base })
    last = { platform, theme }
    flush()
  }, [id, background, base, platform, theme])

  useEffect(
    () => () => {
      requests.delete(id)
      flush()
    },
    [id]
  )
}
