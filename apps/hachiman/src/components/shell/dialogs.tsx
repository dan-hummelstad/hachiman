import type { Channel } from '@hachiman/client'
import { CircleAlert, OctagonAlert, Trash2 } from 'lucide-react'
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
import { CustomStatusSheet, StatusSheet } from '@/components/settings/status-sheet'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { MessageInfoDialog } from '@/components/chat/message-info-dialog'
import { NotifySettingsDialog } from '@/components/notify/notify-menu'
import { CreateThreadDialog } from '@/components/threads/create-thread-dialog'
import { VerifyCallDialog } from '@/components/voice/verify-call-dialog'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import { useLatched } from '@/hooks/use-latched'
import { useLayout } from '@/hooks/use-layout'
import { channelKindName } from '@/lib/model'
import { hachiman } from '@/services/hachiman'
import { useChannelStore } from '@/stores/channelStore'
import { useDialogStore, type AnyDialogKind, type DialogOf } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'

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
  status: StatusSheet,
  customStatus: CustomStatusSheet,
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
function DialogSlot({ kind }: { kind: AnyDialogKind }): React.JSX.Element | null {
  const id = useLatched(useDialogStore((s) => (s.dialog?.kind === kind ? s.dialog.id : null)))
  const Component = DIALOGS[kind]
  return id === null ? null : <Component key={id} />
}

const useDeletedChannel = (d: DialogOf<'deleteChannel'>): Channel | undefined =>
  useChannelStore((s) => s.channels.get(d.channelId))

/**
 * Confirm window for deleting a channel or category. On the mobile layout (M51) it is a centred
 * dialog over the open drawer, where the row stays marked red: the type and guild as the subtitle,
 * the body at 15, and the undo note with `OctagonAlert`.
 */
function DeleteChannelDialog(): React.JSX.Element {
  const { subject: target, open, close } = useDialogSubject('deleteChannel', useDeletedChannel)
  const mobile = useLayout() === 'mobile'
  const guildName = useGuildStore((s) =>
    target?.guildId ? (s.guilds.get(target.guildId)?.name ?? null) : null
  )
  const kind = target?.type === 'category' ? 'category' : 'channel'

  const name = target?.name ?? ''
  const label = target?.type === 'text' || target?.type === 'pages' ? `#${name}` : name

  return (
    <ConfirmDialog
      open={open}
      title={`Delete ${label}?`}
      description={
        mobile && target
          ? [channelKindName(target.type), guildName].filter(Boolean).join(' · ')
          : undefined
      }
      confirmLabel={`Delete ${kind}`}
      tone="danger"
      icon={<Trash2 />}
      confirmIcon
      onConfirm={async () => {
        if (target) await hachiman.rest.deleteChannel(target.id)
      }}
      onClose={close}
      body={
        mobile ? (
          <DeleteChannelBodyMobile label={label} type={target?.type} />
        ) : (
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
        )
      }
    />
  )
}

/**
 * The mobile body of the delete confirm (M51): the body at 15 names what goes with the channel (a
 * pages channel loses its pages too), and the undo note with `OctagonAlert`.
 */
function DeleteChannelBodyMobile({
  label,
  type
}: {
  label: string
  type: Channel['type'] | undefined
}): React.JSX.Element {
  const lost =
    type === 'text'
      ? ', along with its whole message history'
      : type === 'pages'
        ? ', along with its pages and its whole message history'
        : ''
  return (
    <div className="grid gap-3">
      <p className="text-[15px] leading-[1.5] font-medium">
        <span className="font-extrabold">{label}</span> will be removed for everyone{lost}.
      </p>
      <p className="text-feature-danger-text flex items-center gap-2 text-sm font-bold">
        <OctagonAlert aria-hidden className="text-feature-danger size-4 shrink-0" />
        You can&apos;t undo this.
      </p>
    </div>
  )
}
