import { useEffect, useState } from 'react'
import { History, KeyRound, Link2, ShieldAlert, TriangleAlert, X } from 'lucide-react'
import type { CryptoEvents } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { useUserName } from '@/components/security/use-user-name'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { useChannelStore } from '@/stores/channelStore'
import {
  dismissForkAlert,
  dismissInviteHistoryFailure,
  dismissKeyChange,
  useCryptoStore
} from '@/stores/cryptoStore'
import { openDialog, useDialogStore } from '@/stores/dialogStore'
import { openSettings } from '@/stores/navStore'
import { useGuildStore } from '@/stores/guildStore'

/**
 * Security notices in the corner of the shell, while the identity of this device is ready:
 * - key changes of unverified contacts (quiet). A key change of a verified contact opens the
 *   blocking 'keyChange' dialog whenever no other dialog is open;
 * - fork alerts (§12.8.7) and key transparency alerts (§12.14);
 * - a link request from a new device of the user (§12.5, DEVICE_LINK);
 * - the history of an invite that did not open after the join (§12.11.4);
 * - no recovery key on a primary device.
 */
export function SecurityNotices(): React.JSX.Element | null {
  const ready = useCryptoStore((s) => s.phase === 'ready' && s.status?.state === 'ready')
  return ready ? <Notices /> : null
}

function Notices(): React.JSX.Element {
  const keyChanges = useCryptoStore((s) => s.keyChanges)
  const forkAlerts = useCryptoStore((s) => s.forkAlerts)
  const inviteFailures = useCryptoStore((s) => s.inviteHistoryFailures)
  const ktAlertCount = useCryptoStore((s) => s.ktAlerts.length)
  const noRecovery = useCryptoStore(
    (s) => s.status?.primary === true && s.status.recoveryConfigured === false
  )
  const dialogOpen = useDialogStore((s) => s.dialog !== null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const hide = (key: string): void => setHidden((h) => new Set(h).add(key))
  const linkRequest = useLinkRequest()

  // A verified contact's key change blocks until the user decides.
  const blocking = keyChanges.find((k) => k.severity === 'blocking')
  useEffect(() => {
    if (blocking && !dialogOpen)
      openDialog({ kind: 'keyChange', userId: blocking.userId, severity: 'blocking' })
  }, [blocking, dialogOpen])

  const notices: React.ReactNode[] = []
  if (linkRequest.sessionId && !hidden.has(`link:${linkRequest.sessionId}`)) {
    const id = linkRequest.sessionId
    notices.push(
      <Notice
        key={`link:${id}`}
        icon={<Link2 />}
        text="A new device asks to link to your account. Link it only if it is your device."
        action="Review"
        onAction={() => {
          hide(`link:${id}`)
          openDialog({ kind: 'deviceLink', role: 'existing_device', sessionId: id })
        }}
        onDismiss={() => hide(`link:${id}`)}
      />
    )
  }
  for (const k of keyChanges) {
    if (k.severity !== 'notice') continue
    notices.push(<KeyChangeNotice key={`key:${k.userId}`} change={k} />)
  }
  for (const f of forkAlerts) notices.push(<ForkNotice key={`fork:${f.groupId}`} alert={f} />)
  for (const g of inviteFailures)
    notices.push(<InviteHistoryNotice key={`invite:${g}`} guildId={g} />)
  if (ktAlertCount > 0)
    notices.push(
      <Notice
        key="kt"
        tone="danger"
        icon={<ShieldAlert />}
        text="The security check found a key change for your account that you did not make."
        action="Open the security log"
        onAction={() => openSettings({ kind: 'user' }, 'securityLog')}
      />
    )
  if (noRecovery && !hidden.has('recovery'))
    notices.push(
      <Notice
        key="recovery"
        icon={<KeyRound />}
        text="Your account has no recovery key. Without it, you can lose your messages."
        action="Make a recovery key"
        onAction={() => openDialog({ kind: 'recoveryKey' })}
        onDismiss={() => hide('recovery')}
      />
    )

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {notices.slice(0, 4)}
    </div>
  )
}

/** The newest DEVICE_LINK session that another device of mine opened, first sight only. */
function useLinkRequest(): { sessionId: string | null } {
  const [sessionId, setSessionId] = useState<string | null>(null)
  useEffect(() => {
    const seen = new Set<string>()
    const onLink = (d: { sessionId: string; fromDevice: string }): void => {
      if (seen.has(d.sessionId)) return
      seen.add(d.sessionId)
      const own = useCryptoStore.getState().status?.deviceId
      // The messages of a link that this device runs come while its dialog is open.
      const linking = useDialogStore.getState().dialog?.kind === 'deviceLink'
      if (d.fromDevice !== own && !linking) setSessionId(d.sessionId)
    }
    hachiman.on('DEVICE_LINK', onLink)
    return () => {
      hachiman.off('DEVICE_LINK', onLink)
    }
  }, [])
  return { sessionId }
}

function KeyChangeNotice({ change }: { change: CryptoEvents['keyChange'] }): React.JSX.Element {
  const name = useUserName(change.userId)
  return (
    <Notice
      icon={<ShieldAlert />}
      text={`The security key of ${name} changed.`}
      action="Details"
      onAction={() => openDialog({ kind: 'keyChange', userId: change.userId, severity: 'notice' })}
      onDismiss={() => dismissKeyChange(change.userId)}
    />
  )
}

function ForkNotice({ alert }: { alert: CryptoEvents['forkAlert'] }): React.JSX.Element {
  const channelName = useChannelStore((s) =>
    alert.channelId ? (s.channels.get(alert.channelId)?.name ?? null) : null
  )
  return (
    <Notice
      tone="danger"
      icon={<TriangleAlert />}
      text={`The encryption of ${channelName ? `#${channelName}` : 'a conversation'} got out of step. Hachiman repairs it now. Some messages can show late.`}
      onDismiss={() => dismissForkAlert(alert.groupId)}
    />
  )
}

function InviteHistoryNotice({ guildId }: { guildId: string }): React.JSX.Element {
  const guildName = useGuildStore((s) => s.guilds.get(guildId)?.name ?? null)
  return (
    <Notice
      icon={<History />}
      text={`Hachiman could not open the history of ${guildName ?? 'the guild'} from the invite. You are a member, but you see the earlier messages only when a member shares them.`}
      onDismiss={() => dismissInviteHistoryFailure(guildId)}
    />
  )
}

function Notice({
  icon,
  text,
  action,
  onAction,
  onDismiss,
  tone
}: {
  icon: React.ReactNode
  text: string
  action?: string
  onAction?: () => void
  onDismiss?: () => void
  tone?: 'danger'
}): React.JSX.Element {
  return (
    <div
      role="status"
      className={cn(
        'bg-popover text-foreground pointer-events-auto flex items-start gap-2 border p-3 text-sm shadow-lg',
        '[&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
        tone === 'danger' && 'border-destructive'
      )}
    >
      {icon}
      <div className="grid min-w-0 flex-1 gap-2">
        <p className="leading-5">{text}</p>
        {action && onAction && (
          <div>
            <Button size="sm" variant="outline" onClick={onAction}>
              {action}
            </Button>
          </div>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-foreground -m-1 p-1"
          onClick={onDismiss}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}
