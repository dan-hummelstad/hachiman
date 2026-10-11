import type { Channel } from '@hachiman/client'
import { CircleAlert, Trash2 } from 'lucide-react'
import { AddServerDialog } from '@/components/add-server-dialog'
import { CreateChannelDialog } from '@/components/create-channel-dialog'
import { EventDialog } from '@/components/events/event-dialog'
import { InviteDialog } from '@/components/invite-dialog'
import { JoinServerModal } from '@/components/join-server-modal'
import { RemoveServerDialog } from '@/components/remove-server-dialog'
import { DeviceLinkDialog } from '@/components/security/device-link-dialog'
import { DevicesDialog } from '@/components/security/devices-panel'
import { KeyChangeDialog } from '@/components/security/key-change-dialog'
import { RecoveryKeyDialog } from '@/components/security/recovery-panel'
import { SecuritySetupDialog } from '@/components/security/security-setup-dialog'
import { VerificationDialog } from '@/components/security/verification-dialog'
import { SignOutSheet } from '@/components/settings/sign-out-sheet'
import { StatusSheets } from '@/components/settings/status-sheet'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { MessageInfoDialog } from '@/components/chat/message-info-dialog'
import { NotifySettingsDialog } from '@/components/notify/notify-menu'
import { CreateThreadDialog } from '@/components/threads/create-thread-dialog'
import { VerifyCallDialog } from '@/components/voice/verify-call-dialog'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import { useLatched } from '@/hooks/use-latched'
import { hachiman } from '@/services/hachiman'
import { useChannelStore } from '@/stores/channelStore'
import { useDialogStore, type AnyDialogKind, type DialogOf } from '@/stores/dialogStore'

/** The component for each dialog kind; each reads its own request via `useDialog(kind)`. */
const DIALOGS: Record<AnyDialogKind, () => React.JSX.Element> = {
  addGuild: AddServerDialog,
  joinInvite: JoinServerModal,
  removeGuild: RemoveServerDialog,
  invite: InviteDialog,
  createChannel: CreateChannelDialog,
  deleteChannel: DeleteChannelDialog,
  guildEvent: EventDialog,
  createThread: CreateThreadDialog,
  notifySettings: NotifySettingsDialog,
  messageInfo: MessageInfoDialog,
  signOut: SignOutSheet,
  // E2EE (§12.4, §12.5, §12.10, §12.11)
  securitySetup: SecuritySetupDialog,
  recoveryKey: RecoveryKeyDialog,
  deviceLink: DeviceLinkDialog,
  verification: VerificationDialog,
  keyChange: KeyChangeDialog,
  devices: DevicesDialog,
  verifyCall: VerifyCallDialog
}

const KINDS = Object.keys(DIALOGS) as AnyDialogKind[]

/**
 * Every app-level dialog, driven by `useDialogStore`, and the status sheets of the mobile
 * settings list, which keep their own open state (`openStatusSheet`).
 */
export function Dialogs(): React.JSX.Element {
  return (
    <>
      {KINDS.map((kind) => (
        <DialogSlot key={kind} kind={kind} />
      ))}
      <StatusSheets />
    </>
  )
}

/**
 * Mounts `kind`'s dialog on its first open and remounts it, keyed by the open's id, on every
 * later one, so each open starts from fresh state. Between opens the last instance stays mounted,
 * which lets it animate closed.
 */
function DialogSlot({ kind }: { kind: AnyDialogKind }): React.JSX.Element | null {
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

  const name = target?.name ?? ''
  const label = target?.type === 'text' || target?.type === 'pages' ? `#${name}` : name

  return (
    <ConfirmDialog
      open={open}
      title={`Delete ${label}?`}
      confirmLabel={`Delete ${kind}`}
      tone="danger"
      icon={<Trash2 />}
      onConfirm={async () => {
        if (target) await hachiman.rest.deleteChannel(target.id)
      }}
      onClose={close}
      body={
        <div className="grid gap-2.5">
          <p>
            <span className="font-bold">{label}</span> will be removed for everyone
            {target?.type === 'text' ? ', with its message history' : ''}.
          </p>
          <p className="text-feature-danger-text flex items-center gap-1.5 font-semibold">
            <CircleAlert aria-hidden className="size-4" />
            You can&apos;t undo this.
          </p>
        </div>
      }
    />
  )
}
