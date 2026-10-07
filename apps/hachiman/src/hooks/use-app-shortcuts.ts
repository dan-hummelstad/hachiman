import { useEffect } from 'react'
import { hachiman } from '@/services/hachiman'
import { useDocsStore } from '@/stores/docsStore'
import { useGuildStore } from '@/stores/guildStore'
import { back, forward, navigate, type View } from '@/stores/navStore'
import { useTabsStore, viewOfTarget } from '@/stores/tabsStore'

/** Whether the target of a history entry is still there (N2: a gone target is skipped). */
export function viewExists(view: View): boolean {
  const { channels } = hachiman.cache
  switch (view.kind) {
    case 'dmHome':
      return true
    case 'guild':
      return useGuildStore.getState().guilds.has(view.guildId)
    case 'dm':
    case 'channel':
      return channels.has(view.channelId)
    case 'page': {
      if (!channels.has(view.channelId)) return false
      const pages = useDocsStore.getState().pagesByChannel.get(view.channelId)
      return pages === undefined || pages.some((p) => p.id === view.pageId)
    }
    case 'settings': {
      const scope = view.settings.scope
      if (scope.kind === 'guild') return useGuildStore.getState().guilds.has(scope.guildId)
      if (scope.kind === 'channel') return channels.has(scope.channelId)
      return true
    }
  }
}

export const goBack = (): boolean => back(viewExists)
export const goForward = (): boolean => forward(viewExists)

/** Opens pinned tab `index` (0-based). False when there is no such tab. */
export function openTab(index: number): boolean {
  const tab = useTabsStore.getState().tabs[index]
  if (!tab) return false
  navigate(viewOfTarget(tab))
  return true
}

/**
 * The app-wide navigation keys: ⌘[ / ⌘] (Ctrl on Windows and Linux) back and forward, the mouse
 * back and forward buttons, and ⌘1–⌘9 for the pinned tabs (N1, N2). Mount once in the shell.
 */
export function useAppShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = navigator.platform.toLowerCase().includes('mac') ? e.metaKey : e.ctrlKey
      if (!mod || e.altKey || e.shiftKey) return
      let handled = false
      if (e.key === '[') handled = goBack()
      else if (e.key === ']') handled = goForward()
      else if (e.key >= '1' && e.key <= '9') handled = openTab(Number(e.key) - 1)
      if (handled) e.preventDefault()
    }
    // Buttons 3 and 4: the mouse back and forward buttons.
    const onMouse = (e: MouseEvent): void => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      if (e.button === 3) goBack()
      else goForward()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [])
}
