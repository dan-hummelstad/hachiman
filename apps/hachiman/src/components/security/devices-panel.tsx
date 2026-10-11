import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Link2, LogOut, MonitorSmartphone, Pencil } from 'lucide-react'
import type { DeviceSummary } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Chip } from '@/components/ui/chip'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { ModalWindow } from '@/components/ui/modal-window'
import { RemoveDeviceBody, SignOutThisDeviceBody } from '@/components/security/device-actions'
import {
  activeText,
  PRIMARY_ONLY,
  useRenameDevice,
  type RemoveReason
} from '@/components/security/device-model'
import { DevicesScreen } from '@/components/security/devices-screen'
import { cryptoErrorText, friendly } from '@/components/security/errors'
import { HostTrustLine } from '@/components/security/host-trust'
import { useLayout } from '@/hooks/use-layout'
import { PLATFORM_ICON, PLATFORM_LABEL } from '@/lib/device-platform'
import { formatShortDate } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/hachiman'
import { openDialog, useDialog } from '@/stores/dialogStore'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openSettings } from '@/stores/navStore'

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
 * its footer. The page on the mobile layout is the devices screen (M25).
 */
export function DevicesPanel({ variant }: { variant: 'page' | 'dialog' }): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const { devices, error, reload } = useOwnDevices()
  const primary = useCryptoStore((s) => s.status?.primary ?? false)
  const [removing, setRemoving] = useState<DeviceSummary | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  if (mobile && variant === 'page') {
    return <DevicesScreen devices={devices} error={error} reload={reload} />
  }
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
        body={<SignOutThisDeviceBody />}
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
  const { rename, busy, error } = useRenameDevice(device, onRenamed)

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if ((await rename(name ?? '')) !== 'failed') setName(null)
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
              {device.current && (
                <Chip size="sm" tone="accent">
                  This device
                </Chip>
              )}
              {device.primary && (
                <Chip size="sm" tone="voice" icon={<KeyRound aria-hidden />}>
                  Has security key
                </Chip>
              )}
              {device.status === 'pending' && (
                <Chip size="sm" tone="event">
                  Not linked
                </Chip>
              )}
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
      body={<RemoveDeviceBody reason={reason} onReasonChange={setReason} />}
    />
  )
}

/**
 * Dialog kind 'devices' (I9): the same list in a window. The mobile layout has no window for it:
 * settings push the devices screen (M25) instead.
 */
export function DevicesDialog(): React.JSX.Element {
  const { open, close } = useDialog('devices')
  const mobile = useLayout() === 'mobile'
  const { devices } = useOwnDevices(open && !mobile)
  const count = devices?.filter((d) => d.status !== 'revoked').length
  useEffect(() => {
    if (!mobile || !open) return
    close()
    openSettings({ kind: 'user' }, 'devices')
  }, [mobile, open, close])
  if (mobile) return <></>
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
