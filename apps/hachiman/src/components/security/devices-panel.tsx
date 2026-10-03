import { useCallback, useEffect, useState } from 'react'
import { Globe, Laptop, Link2, LogOut, Pencil, Trash2 } from 'lucide-react'
import type { DeviceSummary, RevocationReasonName } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText, Field, SectionHeading } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { ModalWindow } from '@/components/ui/modal-window'
import { NativeSelect } from '@/components/ui/native-select'
import { cryptoErrorText, friendly } from '@/components/security/errors'
import { HostTrustLine } from '@/components/security/host-trust'
import { Warning } from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
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
  'Only a device with your security key can remove other devices: your first device, or a device that you restored with the recovery key.'

/** The own devices of the user from the Worker. Reloads on USER_KEYS_UPDATE for the own user. */
function useOwnDevices(): {
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
    reload()
    const onKeys = ({ userId }: { userId: string }): void => {
      if (userId === hachiman.cache.user?.id) reload()
    }
    hachiman.on('USER_KEYS_UPDATE', onKeys)
    return () => {
      hachiman.off('USER_KEYS_UPDATE', onKeys)
    }
  }, [reload])
  return { devices, error, reload }
}

/**
 * The own device list (§12.5, §12.12): rename (the REST name only), remove another device
 * (primary device only, signed by the master key), sign out of this device.
 */
export function DevicesPanel(): React.JSX.Element {
  const { devices, error, reload } = useOwnDevices()
  const primary = useCryptoStore((s) => s.status?.primary ?? false)
  const [removing, setRemoving] = useState<DeviceSummary | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const active = devices?.filter((d) => d.status !== 'revoked') ?? []
  const removed = devices?.filter((d) => d.status === 'revoked') ?? []

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <p className="text-muted-foreground text-xs leading-4">
          Each device has its own keys. Messages are encrypted for each device on this list.
        </p>
        <HostTrustLine />
        <div>
          <Button
            variant="outline"
            onClick={() =>
              openDialog({ kind: 'deviceLink', role: 'existing_device', sessionId: null })
            }
          >
            <Link2 /> Link a new device
          </Button>
        </div>
      </div>

      <section className="grid gap-2">
        <SectionHeading>Your devices</SectionHeading>
        <ErrorText>{error}</ErrorText>
        {devices === null && !error && <p className="text-muted-foreground text-sm">Loading…</p>}
        <ul className="divide-border divide-y border">
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
        {!primary && <p className="text-muted-foreground text-xs leading-4">{PRIMARY_ONLY}</p>}
      </section>

      {removed.length > 0 && (
        <section className="grid gap-2">
          <SectionHeading>Removed devices</SectionHeading>
          <ul className="text-muted-foreground grid gap-1 text-sm">
            {removed.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <PlatformIcon platform={d.platform} />
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

function PlatformIcon({ platform }: { platform: DeviceSummary['platform'] }): React.JSX.Element {
  return platform === 'electron' ? (
    <Laptop aria-label="Desktop app" className="size-4 shrink-0" />
  ) : (
    <Globe aria-label="Browser" className="size-4 shrink-0" />
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

  return (
    <li className="grid gap-1 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <PlatformIcon platform={device.platform} />
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
              <Button type="submit" size="sm" disabled={busy}>
                Save
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{device.name}</span>
              {device.current && <Tag>This device</Tag>}
              {device.primary && <Tag>Has security key</Tag>}
              {device.status === 'pending' && <Tag tone="warn">Not linked</Tag>}
            </div>
          )}
          <p className="text-muted-foreground text-xs leading-4">
            Added {new Date(device.createdAt).toLocaleDateString()}
            {device.lastSeenAt && ` · Last seen ${new Date(device.lastSeenAt).toLocaleString()}`}
          </p>
        </div>
        {name === null && (
          <div className="flex shrink-0 items-center gap-1">
            <IconButton label="Rename" size="sm" onClick={() => setName(device.name)}>
              <Pencil />
            </IconButton>
            {device.current ? (
              <Button variant="ghost" size="sm" className="text-destructive" onClick={onSignOut}>
                <LogOut /> Sign out
              </Button>
            ) : (
              <IconButton
                label={
                  canRemove
                    ? 'Remove device'
                    : 'Only a device with your security key can remove devices'
                }
                size="sm"
                tone="danger"
                disabled={!canRemove}
                onClick={onRemove}
              >
                <Trash2 />
              </IconButton>
            )}
          </div>
        )}
      </div>
      {name !== null && (
        <p className="text-muted-foreground text-xs leading-4">
          Only you see this name. Other people see the name that the device had when it was linked.
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </li>
  )
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: 'warn' }): React.JSX.Element {
  return (
    <span
      className={cn(
        'shrink-0 border px-1.5 text-[11px] leading-4',
        tone === 'warn' ? 'border-idle text-idle' : 'text-muted-foreground'
      )}
    >
      {children}
    </span>
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
      title={`Remove ${device.name}`}
      confirmLabel="Remove device"
      what="remove the device"
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
            <Warning>
              The device keeps the messages that it already has. If someone else has it, also change
              your password.
            </Warning>
          )}
        </div>
      }
    />
  )
}

/** Dialog kind 'devices': the same list in a window. */
export function DevicesDialog(): React.JSX.Element {
  const { open, close } = useDialog('devices')
  return (
    <ModalWindow open={open} onClose={close} title="Devices" className="sm:max-w-[600px]">
      <div className="max-h-[70vh] overflow-y-auto">
        <DevicesPanel />
      </div>
    </ModalWindow>
  )
}
