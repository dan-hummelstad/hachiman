import { useState } from 'react'
import { ChevronRight, Link2, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { DeviceSummary } from '@hachiman/crypto'
import { DockedFoot, MobileFoot } from '@/components/mobile/foot'
import { ListRow } from '@/components/mobile/list'
import { MobileCap, MobileCard, MobileNote } from '@/components/settings/user/rows'
import { deviceMeta } from '@/components/security/device-model'
import { DeviceSheet } from '@/components/security/device-sheet'
import { DeviceGlyph } from '@/components/security/device-tile'
import { WebTrustCallout } from '@/components/security/host-trust'
import { Button } from '@/components/ui/button'
import { useLatched } from '@/hooks/use-latched'
import { PLATFORM_LABEL } from '@/lib/device-platform'
import { cn } from '@/lib/utils'
import { takusenService } from '@/services/TakusenService'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openDialog } from '@/stores/dialogStore'
import { setSettingsSection } from '@/stores/navStore'

const NOTE = 'text-text-tertiary text-[13px] leading-normal'

const ROW =
  'flex w-full items-center gap-3 py-3 pr-3.5 pl-3.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-line-focus active:bg-surface-hover'

const linkNewDevice = (): void =>
  openDialog({ kind: 'deviceLink', role: 'existing_device', sessionId: null })

/**
 * The devices page on the mobile layout, in the settings screen that pushes it (the screen shows
 * the intro): the web-trust callout, THIS DEVICE, SIGNED IN ELSEWHERE as rows that open the device
 * sheet, the recovery key row, the note, the signed-out devices, and "Link a new device" docked at
 * the foot. The page gives the own devices (`useOwnDevices`).
 */
export function DevicesScreen({
  devices,
  error,
  reload
}: {
  devices: DeviceSummary[] | null
  error: string | null
  reload: () => void
}): React.JSX.Element {
  const primary = useCryptoStore((s) => s.status?.primary ?? false)
  const recoveryConfigured = useCryptoStore((s) => s.status?.recoveryConfigured === true)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [now] = useState(Date.now)
  const active = devices?.filter((d) => d.status !== 'revoked') ?? []
  const removed = devices?.filter((d) => d.status === 'revoked') ?? []
  const here = active.find((d) => d.current)
  const elsewhere = active.filter((d) => !d.current)
  // The sheet keeps its device while it slides out.
  const shown = useLatched(devices?.find((d) => d.id === openId))

  return (
    <div ref={setRoot} className="flex flex-col gap-3">
      <WebTrustCallout devices={devices} desktopAppUrl={`${takusenService.env.issuerOrigin}/`} />

      {error && (
        <p role="alert" className="text-you-text text-[13.5px] leading-[18px] font-semibold">
          {error}
        </p>
      )}
      {devices === null && !error && <p className={NOTE}>Loading…</p>}

      {here && (
        <>
          <MobileCap>This device</MobileCap>
          <MobileCard>
            <button type="button" onClick={() => setOpenId(here.id)} className={cn(ROW, 'p-[15px]')}>
              <DeviceGlyph
                platform={here.platform}
                label={PLATFORM_LABEL[here.platform]}
                className="text-text-secondary size-5 shrink-0"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-text-primary truncate text-[14.5px] font-semibold">
                  {here.name}
                </span>
                <span className="text-text-tertiary truncate font-mono text-[10px]">
                  {deviceMeta(here, now)}
                </span>
              </span>
              <span className="bg-surface-selected text-text-secondary rounded-pill px-2.5 py-1 font-mono text-[8px] uppercase">
                In use
              </span>
            </button>
          </MobileCard>
        </>
      )}

      {elsewhere.length > 0 && (
        <>
          <MobileCap>Signed in elsewhere · {elsewhere.length}</MobileCap>
          <MobileCard>
            {elsewhere.map((d) => (
              <DeviceButton key={d.id} device={d} now={now} onOpen={() => setOpenId(d.id)} />
            ))}
          </MobileCard>
          <p className={NOTE}>Tap a device to rename it or sign it out.</p>
        </>
      )}

      {devices !== null && (
        <>
          <MobileCap>Recovery</MobileCap>
          <MobileCard>
            <ListRow
              tile="neutral"
              label="Recovery key"
              detail="Six words that let you back in with no device."
              value={
                <span
                  className={cn(
                    'text-[13px] font-semibold',
                    recoveryConfigured ? 'text-text-secondary' : 'text-you-text'
                  )}
                >
                  {recoveryConfigured ? 'Open' : 'Set up'}
                </span>
              }
              onClick={() => setSettingsSection('recovery')}
            />
          </MobileCard>
          <MobileNote>
            Every message is encrypted to the devices on this list. Sign a device out and it stops
            being able to read anything new.
          </MobileNote>
        </>
      )}

      {removed.length > 0 && (
        <>
          <MobileCap>Signed-out devices</MobileCap>
          <MobileCard>
            {removed.map((d) => (
              <ListRow
                key={d.id}
                icon={<DeviceGlyph platform={d.platform} />}
                tile="neutral"
                label={d.name}
                detail={PLATFORM_LABEL[d.platform]}
              />
            ))}
          </MobileCard>
        </>
      )}

      <DeviceSheet
        device={shown}
        open={openId !== null}
        onOpenChange={(open) => !open && setOpenId(null)}
        canRemove={primary}
        onChanged={reload}
      />

      <DockedFoot anchor={root}>
        <MobileFoot className="bg-surface-content -mx-4">
          <Button size="mobile" onClick={linkNewDevice}>
            <Link2 /> Link a new device
          </Button>
        </MobileFoot>
      </DockedFoot>
    </div>
  )
}

/**
 * One device row: the platform icon, the name, the app and when it was active in mono caps, the
 * primary and unlinked marks, a chevron. The row opens the sheet.
 */
function DeviceButton({
  device,
  now,
  onOpen
}: {
  device: DeviceSummary
  now: number
  onOpen: () => void
}): React.JSX.Element {
  const pending = device.status === 'pending'
  return (
    <button type="button" onClick={onOpen} className={ROW}>
      <DeviceGlyph
        platform={device.platform}
        label={PLATFORM_LABEL[device.platform]}
        className="text-text-tertiary size-4 shrink-0"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-text-primary truncate text-[13.5px] leading-[18px] font-medium">
          {device.name}
        </span>
        <span className="text-text-disabled truncate font-mono text-[8.5px] uppercase">
          {deviceMeta(device, now)}
        </span>
      </span>
      {device.primary && (
        <ShieldCheck aria-label="Has security key" className="text-text-tertiary size-3.5" />
      )}
      {pending && (
        <span className="text-you-text flex items-center gap-1 font-mono text-[8.5px] font-semibold uppercase">
          <ShieldAlert aria-hidden className="text-you size-3.5" />
          Not linked
        </span>
      )}
      <ChevronRight aria-hidden className="text-text-disabled size-[17px] shrink-0" />
    </button>
  )
}
