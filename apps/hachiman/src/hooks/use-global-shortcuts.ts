import { useEffect } from 'react'
import { useKeybindRuntime } from '@/hooks/use-keybinds'
import { KEYBINDS, resolveKeybinds, toAccelerator, type KeybindAction } from '@/lib/keybinds'
import { voiceService } from '@/services/VoiceService'
import { usePlatform } from '@/shared/PlatformContext'
import type { GlobalShortcut } from '@/shared/IPlatformService'
import { usePrefsStore } from '@/stores/prefsStore'

/**
 * Desktop: hands the `global` keybinds (mute, deafen) to the host, which registers them with the
 * OS, and runs them when they fire. Off while the setting is off or a combo is being recorded.
 * The browser host has none (null). Mount once in the shell.
 */
export function useGlobalShortcuts(): void {
  const platform = usePlatform()
  const overrides = usePrefsStore((s) => s.keybinds)
  const enabled = usePrefsStore((s) => s.globalKeybinds)
  const recording = useKeybindRuntime((s) => s.recording)

  useEffect(
    () =>
      platform.onGlobalShortcut((action) => {
        if (action === 'toggleMute') voiceService.toggleMute()
        else if (action === 'toggleDeafen') voiceService.toggleDeaf()
      }),
    [platform]
  )

  useEffect(() => {
    const binds = resolveKeybinds(overrides)
    const list: GlobalShortcut[] = []
    if (enabled && !recording)
      for (const k of KEYBINDS) {
        const combo = k.global ? binds[k.id] : null
        const accelerator = combo ? toAccelerator(combo) : null
        if (accelerator) list.push({ action: k.id, accelerator })
      }
    let live = true
    platform.setGlobalShortcuts(list).then(
      (refused) => {
        if (!live) return
        const failed = (refused ?? []) as KeybindAction[]
        const active =
          refused === null
            ? []
            : list.map((s) => s.action as KeybindAction).filter((a) => !failed.includes(a))
        useKeybindRuntime.setState({ globalActive: active, globalFailed: failed })
      },
      (e: unknown) => {
        console.warn('[keybinds] global shortcuts failed', e)
        if (live) useKeybindRuntime.setState({ globalActive: [], globalFailed: [] })
      }
    )
    return () => {
      live = false
    }
  }, [platform, overrides, enabled, recording])

  // Signed out (the shell unmounts): let the keys go.
  useEffect(
    () => () => {
      useKeybindRuntime.setState({ globalActive: [], globalFailed: [] })
      platform.setGlobalShortcuts([]).catch(() => undefined)
    },
    [platform]
  )
}
