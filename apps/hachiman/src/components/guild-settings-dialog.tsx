import type { Guild } from '@hachiman/client'
import { SettingsOverlay } from '@/components/settings/settings-overlay'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import type { DialogOf } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'

const useSettingsGuild = (d: DialogOf<'guildSettings'>): Guild | undefined =>
  useGuildStore((s) => s.guilds.get(d.guildId))

/** Guild settings (G1–G4). Each section only shows if the user holds its permission. */
export function GuildSettingsDialog(): React.JSX.Element {
  // Closes itself when the guild is deleted or left underneath us.
  const { dialog, open, close } = useDialogSubject('guildSettings', useSettingsGuild)
  return (
    <SettingsOverlay
      open={open}
      onClose={close}
      label="Guild settings"
      target={{ kind: 'guild', guildId: dialog.guildId }}
    />
  )
}
