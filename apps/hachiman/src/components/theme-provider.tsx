import { useEffect } from 'react'
import { usePrefsStore } from '@/stores/prefsStore'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Applies `prefsStore.theme` as the `light`/`dark` class on `<html>`; `system` tracks the OS. */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theme = usePrefsStore((s) => s.theme)

  useEffect(() => {
    const root = document.documentElement
    const mq = window.matchMedia(DARK_QUERY)
    const apply = (): void => {
      const resolved = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme
      root.classList.remove('light', 'dark')
      root.classList.add(resolved)
    }
    apply()
    if (theme !== 'system') return
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  return <>{children}</>
}
