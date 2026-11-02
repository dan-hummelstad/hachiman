import { useEffect, useLayoutEffect, useMemo } from 'react'
import { DARK_QUERY, resolveTheme } from '@/lib/theme'
import { deriveTheme, themeCss } from '@/lib/theme-engine'
import { DEFAULT_DARK, DEFAULT_LIGHT, THEME_PRESETS, findTheme } from '@/lib/theme-presets'
import { usePrefsStore } from '@/stores/prefsStore'

const THEME_STYLE_ID = 'hachiman-theme'

/**
 * Applies `prefsStore.theme` as the `light`/`dark` class on `<html>`; `system` tracks the OS. The
 * chosen dark and light themes become one `<style id="hachiman-theme">` of CSS variables. Also
 * writes `prefsStore.messageTextSize` to `--message-text-size` on `<html>` (the mobile transcript).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theme = usePrefsStore((s) => s.theme)
  const textSize = usePrefsStore((s) => s.messageTextSize)
  const darkTheme = usePrefsStore((s) => s.darkTheme)
  const lightTheme = usePrefsStore((s) => s.lightTheme)
  const customThemes = usePrefsStore((s) => s.customThemes)

  const css = useMemo(() => {
    const pick = (id: string, fallback: string) =>
      deriveTheme(
        findTheme(id, customThemes) ?? THEME_PRESETS.find((t) => t.id === fallback) ?? THEME_PRESETS[0]
      )
    return themeCss(pick(darkTheme, DEFAULT_DARK), pick(lightTheme, DEFAULT_LIGHT))
  }, [darkTheme, lightTheme, customThemes])

  useLayoutEffect(() => {
    let el = document.getElementById(THEME_STYLE_ID)
    if (!el) {
      el = document.createElement('style')
      el.id = THEME_STYLE_ID
      document.head.appendChild(el)
    }
    el.textContent = css
  }, [css])

  useEffect(
    () => () => {
      document.getElementById(THEME_STYLE_ID)?.remove()
    },
    []
  )

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
