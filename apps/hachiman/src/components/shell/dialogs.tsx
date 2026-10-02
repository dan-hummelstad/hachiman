import type { Channel } from '@hachiman/client'
import { AddServerDialog } from '@/components/add-server-dialog'
import { ChannelSettingsDialog } from '@/components/channel-settings-dialog'
import { CreateChannelDialog } from '@/components/create-channel-dialog'
import { GuildSettingsDialog } from '@/components/guild-settings-dialog'
import { InviteDialog } from '@/components/invite-dialog'
import { JoinServerModal } from '@/components/join-server-modal'
import { RemoveServerDialog } from '@/components/remove-server-dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { UserSettings } from '@/components/user-settings'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import { useLatched } from '@/hooks/use-latched'
import { hachiman } from '@/services/hachiman'
import { useChannelStore } from '@/stores/channelStore'
import { useDialogStore, type DialogKind, type DialogOf } from '@/stores/dialogStore'

/** The component for each dialog kind; each reads its own request via `useDialog(kind)`. */
const DIALOGS: Record<DialogKind, () => React.JSX.Element> = {
  addGuild: AddServerDialog,
  joinInvite: JoinServerModal,
  guildSettings: GuildSettingsDialog,
  removeGuild: RemoveServerDialog,
  invite: InviteDialog,
  channelSettings: ChannelSettingsDialog,
  createChannel: CreateChannelDialog,
  deleteChannel: DeleteChannelDialog,
  userSettings: UserSettings
}

const KINDS = Object.keys(DIALOGS) as DialogKind[]

/** Every app-level dialog, driven by `useDialogStore`. */
export function Dialogs(): React.JSX.Element {
  return (
    <>
      {KINDS.map((kind) => (
        <DialogSlot key={kind} kind={kind} />
      ))}
    </>
  )
}

/**
 * Mounts `kind`'s dialog on its first open and remounts it, keyed by the open's id, on every
 * later one, so each open starts from fresh state. Between opens the last instance stays mounted,
 * which lets it animate closed.
 */
function DialogSlot({ kind }: { kind: DialogKind }): React.JSX.Element | null {
  const id = useLatched(useDialogStore((s) => (s.dialog?.kind === kind ? s.dialog.id : null)))
  const Component = DIALOGS[kind]
  return id === null ? null : <Component key={id} />
}

const useDeletedChannel = (d: DialogOf<'deleteChannel'>): Channel | undefined =>
  useChannelStore((s) => s.channels.get(d.channelId))

/** Confirm window for deleting a channel or category. */
function DeleteChannelDialog(): React.JSX.Element {
  const { subject: target, open, close } = useDialogSubject('deleteChannel', useDeletedChannel)
  const kind = target?.type === 'category' ? 'category' : 'channel'

  return (
    <ConfirmDialog
      open={open}
      title={`Delete ${kind}`}
      confirmLabel={`Delete ${kind}`}
      tone="danger"
      onConfirm={async () => {
        if (target) await hachiman.rest.deleteChannel(target.id)
      }}
      onClose={close}
      body={
        <p>
          <span className="font-semibold">{target?.name}</span> will be removed for everyone
          {target?.type === 'text' ? ', with its message history' : ''}. You can&apos;t undo this.
        </p>
      }
    />
  )
}
