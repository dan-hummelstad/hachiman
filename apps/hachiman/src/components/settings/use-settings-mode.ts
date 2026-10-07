import { useEffect } from 'react'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { closeSettings, useSettingsView, type SettingsView } from '@/stores/navStore'

/**
 * The settings view the shell shows, or null. A deleted or left guild or channel closes it. Esc
 * leaves it through useAppShortcuts.
 */
export function useSettingsMode(): SettingsView | null {
  const view = useSettingsView()
  const target = view?.target
  const guildGone = useGuildStore((s) => target?.kind === 'guild' && !s.guilds.has(target.guildId))
  const channelGone = useChannelStore(
    (s) => target?.kind === 'channel' && !s.channels.has(target.channelId)
  )
  const gone = guildGone || channelGone

  useEffect(() => {
    if (gone) closeSettings()
  }, [gone])

  return gone ? null : view
}
