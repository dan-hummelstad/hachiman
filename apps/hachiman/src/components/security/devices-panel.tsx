import { useEffect, useState } from 'react'
import { KeyRound, Link2, MonitorSmartphone, Pencil, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { DeviceSummary } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Chip } from '@/components/ui/chip'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { ModalWindow } from '@/components/ui/modal-window'
import { AnswerBlock, SettingsCap, SettingsRule } from '@/components/settings/user/rows'
import { RemoveDeviceBody, SignOutThisDeviceBody } from '@/components/security/device-actions'
import {
  activeText,
  PRIMARY_ONLY,
  useRenameDevice,
  type RemoveReason
} from '@/components/security/device-model'
import { DeviceGlyph } from '@/components/security/device-tile'
import { DevicesScreen } from '@/components/security/devices-screen'
import { friendly } from '@/components/security/errors'
import { HostTrustLine } from '@/components/security/host-trust'
import { useOwnDevices } from '@/components/security/use-own-devices'
import { useLayout } from '@/hooks/use-layout'
import { PLATFORM_LABEL } from '@/lib/device-platform'
import { formatShortDate } from '@/lib/time-format'
import { cryptoService } from '@/services/CryptoService'
import { openDialog, useDialog } from '@/stores/dialogStore'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openSettings, setSettingsSection } from '@/stores/navStore'

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
            <SettingsCap>Devices on your account{devices && ` · ${active.length}`}</SettingsCap>
            <Button variant="secondary" size="sm" onClick={linkNewDevice}>
              <Link2 /> Link a new device
            </Button>
          </div>
        )}
        <ErrorText>{error}</ErrorText>
        {devices === null && !error && <p className="text-text-tertiary text-sm">Loading…</p>}
        {active.length > 0 && (
          <ul className="divide-line-hairline divide-y">
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
        {!primary && <p className="text-[12.5px] text-text-tertiary">{PRIMARY_ONLY}</p>}
      </section>

      {variant === 'page' && <RecoveryPrompt />}

      {removed.length > 0 && (
        <section className="grid gap-2">
          <SettingsCap>Signed-out devices</SettingsCap>
          <ul className="text-text-tertiary grid gap-1 text-[13px]">
            {removed.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <DeviceGlyph
                  platform={d.platform}
                  label={PLATFORM_LABEL[d.platform]}
                  className="size-4"
                />
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

/** No recovery key yet: the one thing on this page that waits on you. */
function RecoveryPrompt(): React.JSX.Element | null {
  const missing = useCryptoStore(
    (s) => s.phase === 'ready' && s.status?.state === 'ready' && s.status.recoveryConfigured === false
  )
  if (!missing) return null
  return (
    <section>
      <SettingsRule />
      <SettingsCap>Recovery key</SettingsCap>
      <div className="mt-2">
        <AnswerBlock
          tone="you"
          icon={<KeyRound className="size-5" />}
          cap="Waiting on you"
          title="You have no recovery key yet"
          body="If you lose every device on this list, the recovery key is the only way to read your messages again."
          actions={<Button onClick={() => setSettingsSection('recovery')}>Make a recovery key</Button>}
        />
      </div>
    </section>
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
    <li className="grid gap-1 py-3">
      <div className="flex min-h-[68px] items-center gap-3.5 py-0">
        <DeviceGlyph
          platform={device.platform}
          label={PLATFORM_LABEL[device.platform]}
          className="text-text-tertiary size-[18px] shrink-0"
        />
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
              <span className="truncate text-[13.5px] font-semibold">{device.name}</span>
              {device.current && <Chip size="sm">This device</Chip>}
              {device.primary && (
                <span className="text-text-tertiary flex items-center gap-1 font-mono text-[8.5px] uppercase">
                  <ShieldCheck aria-hidden className="size-3" />
                  Security key
                </span>
              )}
              {device.status === 'pending' && (
                <span className="text-you-text flex items-center gap-1 font-mono text-[8.5px] font-semibold uppercase">
                  <ShieldAlert aria-hidden className="text-you size-3" />
                  Not linked
                </span>
              )}
            </div>
          )}
          <p className="text-text-disabled font-mono text-[9px] tracking-[0.8px] uppercase">
            {meta.join(' · ')}
          </p>
        </div>
        {name === null && (
          <div className="flex shrink-0 items-center gap-1.5">
            <IconButton label="Rename" size="sm" onClick={() => setName(device.name)}>
              <Pencil />
            </IconButton>
            <Button
              variant="secondary"
              size="sm"
              disabled={!device.current && !canRemove}
              title={device.current || canRemove ? undefined : PRIMARY_ONLY}
              onClick={device.current ? onSignOut : onRemove}
            >
              Sign out
            </Button>
          </div>
        )}
      </div>
      {name !== null && (
        <p className="text-[12.5px] text-text-tertiary pl-8">
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
