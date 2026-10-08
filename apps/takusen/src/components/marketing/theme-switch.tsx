'use client'

import { MoonIcon, SunIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'

import { Segmented, SegmentedItem } from '@/components/ui/segmented'

type Theme = 'dark' | 'light'

// The root layout's inline script sets the `dark` class before first paint (and keeps following
// the system theme when no cookie is set), so the class on <html> is the source of truth.
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

const current = (): Theme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light')

/**
 * Dark / Light in the landing footer. It writes the `theme` cookie that the inline script reads,
 * so the choice holds on every Takusen page.
 */
export function ThemeSwitch(): React.JSX.Element {
  const theme = useSyncExternalStore(subscribe, current, () => 'dark' as const)

  function choose(next: string): void {
    const t: Theme = next === 'light' ? 'light' : 'dark'
    document.cookie = `theme=${t}; path=/; max-age=31536000; samesite=lax`
    document.documentElement.classList.toggle('dark', t === 'dark')
  }

  return (
    <Segmented aria-label="Theme" value={theme} onValueChange={choose}>
      <SegmentedItem value="dark">
        <MoonIcon aria-hidden />
        Dark
      </SegmentedItem>
      <SegmentedItem value="light">
        <SunIcon aria-hidden />
        Light
      </SegmentedItem>
    </Segmented>
  )
}
