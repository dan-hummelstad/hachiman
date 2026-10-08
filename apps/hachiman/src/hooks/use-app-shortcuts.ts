import { useEffect } from 'react'
import { toggleSidebar } from '@/components/shell/sidebar-state'
import { closeSwitcher, isSwitcherOpen, openSwitcher } from '@/components/shell/switcher-state'
import { currentKeybinds, useKeybindRuntime } from '@/hooks/use-keybinds'
import { comboOf, hasCommandModifier, keyOf, splitCombo } from '@/lib/keybinds'
import { inTextField, matchShortcut, underModal } from '@/lib/shortcuts'
import { hachiman } from '@/services/hachiman'
import { voiceService } from '@/services/VoiceService'
import { useDialogStore } from '@/stores/dialogStore'
import { useDocsStore } from '@/stores/docsStore'
import { useGuildStore } from '@/stores/guildStore'
import { back, closeSettings, forward, navigate, useNavStore, type View } from '@/stores/navStore'
import { currentTabs, viewOfTarget } from '@/stores/tabsStore'

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
      const target = view.settings.target
      if (target.kind === 'guild') return useGuildStore.getState().guilds.has(target.guildId)
      if (target.kind === 'channel') return channels.has(target.channelId)
      return true
    }
  }
}

export const goBack = (): boolean => back(viewExists)
export const goForward = (): boolean => forward(viewExists)

/** Opens pinned tab `index` (0-based). False when there is no such tab. */
export function openTab(index: number): boolean {
  const tab = currentTabs()[index]
  if (!tab) return false
  navigate(viewOfTarget(tab))
  return true
}

const MODIFIERS = new Set(['Meta', 'Control', 'Alt', 'Shift'])

/**
 * The app-wide keys (lib/shortcuts.ts, the user's keybinds) and the mouse back and forward
 * buttons. One listener; no key acts under a modal dialog, except ⌘K, which closes an open quick
 * switcher, and push to talk. A key without ⌘ / Ctrl / Alt does not act in a text field. Mount
 * once in the shell.
 */
export function useAppShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { recording, globalActive } = useKeybindRuntime.getState()
      if (recording) return
      const combo = comboOf(e)
      const shortcut = matchShortcut(combo, currentKeybinds())
      if (!combo || !shortcut) return
      if (shortcut.kind === 'switcher' && isSwitcherOpen()) {
        e.preventDefault()
        closeSwitcher()
        return
      }
      if (shortcut.kind !== 'leaveSettings' && !hasCommandModifier(combo) && inTextField(e.target))
        return
      // The desktop host took this one as a global shortcut: it arrives from there.
      if (globalActive.some((a) => a === shortcut.kind)) return
      if (shortcut.kind === 'pushToTalk') {
        e.preventDefault()
        voiceService.setPushToTalk(true)
        return
      }
      if (underModal(e.target, useDialogStore.getState().dialog !== null)) return
      let handled = true
      switch (shortcut.kind) {
        case 'back':
          handled = goBack()
          break
        case 'forward':
          handled = goForward()
          break
        case 'tab':
          handled = openTab(shortcut.index)
          break
        case 'sidebar':
          toggleSidebar()
          break
        case 'switcher':
          openSwitcher('open')
          break
        case 'toggleMute':
          if (!e.repeat) voiceService.toggleMute()
          break
        case 'toggleDeafen':
          if (!e.repeat) voiceService.toggleDeaf()
          break
        case 'leaveSettings':
          // An Esc that a menu or popover took, or that a field in [data-esc-local] uses, stays.
          if (e.defaultPrevented || useNavStore.getState().settings === null) return
          if ((e.target as Element | null)?.closest?.('[data-esc-local]')) return
          closeSettings()
          return
      }
      if (handled) e.preventDefault()
    }
    // Push to talk ends when its key or one of its modifiers comes up, or the window loses focus.
    const onKeyUp = (e: KeyboardEvent): void => {
      const ptt = currentKeybinds().pushToTalk
      if (!ptt) return
      const { mods, key } = splitCombo(ptt)
      if (keyOf(e) === key || (mods.length > 0 && MODIFIERS.has(e.key)))
        voiceService.setPushToTalk(false)
    }
    const onBlur = (): void => voiceService.setPushToTalk(false)
    // Buttons 3 and 4: the mouse back and forward buttons.
    const onMouse = (e: MouseEvent): void => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      if (e.button === 3) goBack()
      else goForward()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [])
}
