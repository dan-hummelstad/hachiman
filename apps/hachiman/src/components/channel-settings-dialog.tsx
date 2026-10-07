import type { Channel } from '@hachiman/client'
import { SettingsOverlay } from '@/components/settings/settings-overlay'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import type { DialogOf } from '@/stores/dialogStore'
import { useChannelStore } from '@/stores/channelStore'

const useSettingsChannel = (d: DialogOf<'channelSettings'>): Channel | undefined =>
  useChannelStore((s) => s.channels.get(d.channelId))

/** Channel settings (F7, F8): rename and topic, permission overwrites. */
export function ChannelSettingsDialog(): React.JSX.Element {
  // Closes itself when the channel is deleted underneath us.
  const { dialog, subject, open, close } = useDialogSubject('channelSettings', useSettingsChannel)
  return (
    <SettingsOverlay
      open={open}
      onClose={close}
      label={subject?.type === 'category' ? 'Category settings' : 'Channel settings'}
      target={{ kind: 'channel', channelId: dialog.channelId }}
    />
  )
}
