import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Link2, LogOut, MonitorSmartphone, Pencil } from 'lucide-react'
import type { DeviceSummary, RevocationReasonName } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText, Field, SectionHeading } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { ModalWindow } from '@/components/ui/modal-window'
import { NativeSelect } from '@/components/ui/native-select'
import { cryptoErrorText, friendly } from '@/components/security/errors'
import { HostTrustLine } from '@/components/security/host-trust'
import { useAction } from '@/hooks/use-action'
import { PLATFORM_ICON, PLATFORM_LABEL } from '@/lib/device-platform'
import { formatShortDate, relativeTime } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/hachiman'
import { openDialog, useDialog } from '@/stores/dialogStore'
import { useCryptoStore } from '@/stores/cryptoStore'

type RemoveReason = Exclude<RevocationReasonName, 'password_reset' | 'signed_out'>

const REASONS: { value: RemoveReason; label: string }[] = [
  { value: 'user', label: 'I do not use it now' },
  { value: 'lost', label: 'I lost it' },
  { value: 'compromised', label: 'Someone else has it' }
]

const PRIMARY_ONLY =
  'Only a device with your security key can sign out other devices: your first device, or a device that you restored with the recovery key.'

/**
 * The own devices of the user from the Worker. Reloads on USER_KEYS_UPDATE for the own user.
 * `enabled` false loads nothing (the Worker is not ready).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useOwnDevices(enabled = true): {
  devices: DeviceSummary[] | null
  error: string | null
  reload: () => void
} {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    Promise.resolve()
      .then(() => cryptoService.client().listDevices())
      .then(
        (d) => {
          setDevices(d)
          setError(null)
        },
        (e: unknown) => setError(cryptoErrorText(e))
      )
  }, [])
  useEffect(() => {
    if (!enabled) return undefined
    reload()
    const onKeys = ({ userId }: { userId: string }): void => {
      if (userId === hachiman.cache.user?.id) reload()
    }
    hachiman.on('USER_KEYS_UPDATE', onKeys)
    return () => {
      hachiman.off('USER_KEYS_UPDATE', onKeys)
    }
  }, [reload, enabled])
  return { devices, error, reload }
}

const linkNewDevice = (): void =>
  openDialog({ kind: 'deviceLink', role: 'existing_device', sessionId: null })

/** The web-trust warning (§12.17) as a gold callout; the desktop app gets one quiet line. */
function HostTrust(): React.JSX.Element | null {
  const hostTrust = useCryptoStore((s) => s.status?.hostTrust ?? null)
  if (hostTrust !== 'server_code') return <HostTrustLine />
  return (
    <Callout tone="caution" title="This browser trusts the server’s code">
      The server sends the web app each time you open it. A server that someone took over could send
      a changed app that reads your messages. Use the desktop app for the best protection.
    </Callout>
  )
}

/**
 * The own device list (§12.5, §12.12) of H2 (settings page) and I9 (dialog): rename (the REST
 * name only), sign out another device (primary device only, signed by the master key), sign out
 * of this device. The page has the "Link a new device" action above the list; the dialog has it in
 * its footer.
 */
export function DevicesPanel({ variant }: { variant: 'page' | 'dialog' }): React.JSX.Element {
  const { devices, error, reload } = useOwnDevices()
  const primary = useCryptoStore((s) => s.status?.primary ?? false)
  const [removing, setRemoving] = useState<DeviceSummary | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const active = devices?.filter((d) => d.status !== 'revoked') ?? []
  const removed = devices?.filter((d) => d.status === 'revoked') ?? []

  return (
    <div className="grid gap-5">
      <HostTrust />

      <section className="grid gap-2">
        {variant === 'page' && (
          <div className="flex items-center justify-between gap-3">
            <SectionHeading className="mb-0">
              Your devices{devices && ` · ${active.length}`}
            </SectionHeading>
            <Button onClick={linkNewDevice}>
              <Link2 /> Link a new device
            </Button>
          </div>
        )}
        <ErrorText>{error}</ErrorText>
        {devices === null && !error && <p className="text-text-tertiary text-sm">Loading…</p>}
        {active.length > 0 && (
          <ul className="bg-surface-panel border-line-hairline divide-line-hairline divide-y border">
            {active.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                canRemove={primary}
                onRemove={() => setRemoving(d)}
                onSignOut={() => setSigningOut(true)}
                onRenamed={reload}
              />
            ))}
          </ul>
        )}
        {!primary && <p className="text-meta text-text-tertiary">{PRIMARY_ONLY}</p>}
      </section>

      {removed.length > 0 && (
        <section className="grid gap-2">
          <SectionHeading className="mb-0">Signed-out devices</SectionHeading>
          <ul className="text-text-tertiary grid gap-1 text-sm">
            {removed.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <PlatformIcon platform={d.platform} className="size-4" />
                <span className="truncate">{d.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {removing && (
        <RemoveDeviceDialog
          device={removing}
          onClose={() => setRemoving(null)}
          onRemoved={reload}
        />
      )}
      <ConfirmDialog
        open={signingOut}
        title="Sign out of this device"
        confirmLabel="Sign out of this device"
        what="sign out of this device"
        tone="danger"
        onClose={() => setSigningOut(false)}
        onConfirm={() => friendly(cryptoService.signOutDevice())}
        body={
          <div className="grid gap-2">
            <p>
              This removes this device from your account and deletes its encryption keys. Your other
              devices are not changed.
            </p>
            <p>
              To use encryption here again, you must link this device from another device or use
              your recovery key.
            </p>
          </div>
        }
      />
    </div>
  )
}

/** The icon of the kind of app that a device runs. */
export function PlatformIcon({
  platform,
  className
}: {
  platform: DeviceSummary['platform']
  className?: string
}): React.JSX.Element {
  const Icon = PLATFORM_ICON[platform]
  return <Icon aria-label={PLATFORM_LABEL[platform]} className={className} />
}

/** "active now", "active 2 hours ago", "active yesterday". */
function activeText(lastSeenAt: string, now: number): string {
  const seen = Date.parse(lastSeenAt)
  return now - seen < 5 * 60_000 ? 'active now' : `active ${relativeTime(lastSeenAt, now)}`
}

function Tag({
  children,
  tone
}: {
  children: React.ReactNode
  tone: 'accent' | 'voice' | 'event'
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center gap-1 px-1.5 text-[10.5px] font-bold [&_svg]:size-3',
        tone === 'accent' && 'bg-accent-tint text-accent-text',
        tone === 'voice' && 'bg-feature-voice/15 text-feature-voice-text',
        tone === 'event' && 'bg-feature-event/15 text-feature-event-text'
      )}
    >
      {children}
    </span>
  )
}

function DeviceRow({
  device,
  canRemove,
  onRemove,
  onSignOut,
  onRenamed
}: {
  device: DeviceSummary
  canRemove: boolean
  onRemove: () => void
  onSignOut: () => void
  onRenamed: () => void
}): React.JSX.Element {
  const [name, setName] = useState<string | null>(null) // non-null while editing
  const [now] = useState(Date.now)
  const { run, busy, error } = useAction()

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const next = name?.trim() ?? ''
    if (!next || next === device.name) return setName(null)
    const r = await run('rename the device', () =>
      friendly(cryptoService.client().renameDevice(device.id, next))
    )
    if (r.ok) {
      setName(null)
      onRenamed()
    }
  }

  const meta = [
    PLATFORM_LABEL[device.platform],
    `added ${formatShortDate(new Date(device.createdAt))}`,
    device.lastSeenAt && activeText(device.lastSeenAt, now)
  ].filter(Boolean)

  return (
    <li className={cn('grid gap-1 px-4 py-3', device.current && 'bg-surface-hover/50')}>
      <div className="flex items-center gap-3">
        <span className="bg-surface-raised text-text-secondary flex size-10 shrink-0 items-center justify-center">
          <PlatformIcon platform={device.platform} className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          {name !== null ? (
            <form onSubmit={(e) => void save(e)} className="flex gap-2" data-esc-local>
              <Input
                aria-label="Device name"
                value={name}
                maxLength={64}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setName(null)}
              />
              <Button type="submit" disabled={busy}>
                Save
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-label truncate">{device.name}</span>
              {device.current && <Tag tone="accent">This device</Tag>}
              {device.primary && (
                <Tag tone="voice">
                  <KeyRound aria-hidden /> Has security key
                </Tag>
              )}
              {device.status === 'pending' && <Tag tone="event">Not linked</Tag>}
            </div>
          )}
          <p className="text-meta text-text-tertiary">{meta.join(' · ')}</p>
        </div>
        {name === null && (
          <div className="flex shrink-0 items-center gap-1.5">
            <IconButton
              label="Rename"
              className="rounded-control bg-surface-raised size-8"
              onClick={() => setName(device.name)}
            >
              <Pencil />
            </IconButton>
            <Button
              variant="quiet"
              className="bg-feature-danger/10 text-feature-danger-text hover:bg-feature-danger/20"
              disabled={!device.current && !canRemove}
              title={device.current || canRemove ? undefined : PRIMARY_ONLY}
              onClick={device.current ? onSignOut : onRemove}
            >
              <LogOut /> Sign out
            </Button>
          </div>
        )}
      </div>
      {name !== null && (
        <p className="text-meta text-text-tertiary pl-[52px]">
          Only you see this name. Other people see the name that the device had when it was linked.
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </li>
  )
}

function RemoveDeviceDialog({
  device,
  onClose,
  onRemoved
}: {
  device: DeviceSummary
  onClose: () => void
  onRemoved: () => void
}): React.JSX.Element {
  const [reason, setReason] = useState<RemoveReason>('user')
  return (
    <ConfirmDialog
      open
      title={`Sign out ${device.name}`}
      confirmLabel="Sign out the device"
      what="sign out the device"
      tone="danger"
      onClose={onClose}
      onConfirm={async () => {
        await friendly(cryptoService.client().revokeDevice(device.id, reason))
        onRemoved()
      }}
      body={
        <div className="grid gap-3">
          <p>
            The device loses access to your account and to new messages. Your other devices get new
            keys.
          </p>
          <Field id="remove-reason" label="Why">
            <NativeSelect
              id="remove-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as RemoveReason)}
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {reason !== 'user' && (
            <Callout tone="caution">
              The device keeps the messages that it already has. If someone else has it, also change
              your password.
            </Callout>
          )}
        </div>
      }
    />
  )
}

/** Dialog kind 'devices' (I9): the same list in a window. */
export function DevicesDialog(): React.JSX.Element {
  const { open, close } = useDialog('devices')
  const { devices } = useOwnDevices(open)
  const count = devices?.filter((d) => d.status !== 'revoked').length
  return (
    <ModalWindow
      open={open}
      onClose={close}
      title="Devices"
      description={
        count === undefined
          ? 'The devices that hold your keys'
          : `${count} ${count === 1 ? 'device holds' : 'devices hold'} your keys`
      }
      icon={<MonitorSmartphone />}
      className="sm:max-w-[620px]"
      actions={
        <>
          <Button
            className="mr-auto"
            onClick={() => {
              close()
              linkNewDevice()
            }}
          >
            <Link2 /> Link a new device
          </Button>
          <Button variant="secondary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <div className="grid max-h-[70vh] gap-3 overflow-y-auto">
        <p className="text-text-secondary text-sm">
          Each device has its own keys. Messages are encrypted for every device on this list.
        </p>
        <DevicesPanel variant="dialog" />
      </div>
    </ModalWindow>
  )
}
