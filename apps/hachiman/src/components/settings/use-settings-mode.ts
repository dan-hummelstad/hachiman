import { useEffect } from 'react'
import { useChannelStore } from '@/stores/channelStore'
import { useDialogStore } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { closeSettings, useSettingsView, type SettingsView } from '@/stores/navStore'

/**
 * The settings view the shell shows, or null. While one shows, `Esc` leaves it (back to the
 * channel), and a deleted or left guild or channel closes it. An `Esc` that a dialog, menu or
 * popover took (Radix prevents its default) or that a field inside `[data-esc-local]` uses stays
 * there.
 */
export function useSettingsMode(): SettingsView | null {
  const view = useSettingsView()
  const target = view?.target
  const guildGone = useGuildStore((s) => target?.kind === 'guild' && !s.guilds.has(target.guildId))
  const channelGone = useChannelStore(
    (s) => target?.kind === 'channel' && !s.channels.has(target.channelId)
  )
  const gone = guildGone || channelGone
  const open = view !== null

  useEffect(() => {
    if (gone) closeSettings()
  }, [gone])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if ((e.target as Element | null)?.closest?.('[data-esc-local]')) return
      if (useDialogStore.getState().dialog !== null) return
      closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return gone ? null : view
}
