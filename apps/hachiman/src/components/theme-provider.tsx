import { useEffect } from 'react'
import { DARK_QUERY, resolveTheme } from '@/lib/theme'
import { usePrefsStore } from '@/stores/prefsStore'

/**
 * Applies `prefsStore.theme` as the `light`/`dark` class on `<html>`; `system` tracks the OS. Also
 * writes `prefsStore.messageTextSize` to `--message-text-size` on `<html>` (the mobile transcript).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theme = usePrefsStore((s) => s.theme)
  const textSize = usePrefsStore((s) => s.messageTextSize)

  useEffect(() => {
    const root = document.documentElement
    const mq = window.matchMedia(DARK_QUERY)
    const apply = (): void => {
      const resolved = resolveTheme(theme, mq.matches)
      root.classList.remove('light', 'dark')
      root.classList.add(resolved)
    }
    apply()
    if (theme !== 'system') return
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    document.documentElement.style.setProperty('--message-text-size', `${textSize}px`)
  }, [textSize])

  return <>{children}</>
}
