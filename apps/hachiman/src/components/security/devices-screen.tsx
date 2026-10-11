import { useState } from 'react'
import { ChevronRight, KeyRound, Link2 } from 'lucide-react'
import type { DeviceSummary } from '@hachiman/crypto'
import { DockedFoot, MobileFoot } from '@/components/mobile/foot'
import { ListGroup, ListRow, SectionLabel } from '@/components/mobile/list'
import { deviceMeta } from '@/components/security/device-model'
import { DeviceSheet } from '@/components/security/device-sheet'
import { DeviceGlyph, DeviceTile } from '@/components/security/device-tile'
import { WebTrustCallout } from '@/components/security/host-trust'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { useLatched } from '@/hooks/use-latched'
import { PLATFORM_LABEL } from '@/lib/device-platform'
import { cn } from '@/lib/utils'
import { takusenService } from '@/services/TakusenService'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openDialog } from '@/stores/dialogStore'

const NOTE = 'text-text-tertiary text-[13px] leading-normal font-medium'

const ROW =
  'flex w-full items-center gap-3 py-3 pr-3.5 pl-3 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-line-focus active:bg-surface-hover'

const linkNewDevice = (): void =>
  openDialog({ kind: 'deviceLink', role: 'existing_device', sessionId: null })

/**
 * The devices page on the mobile layout (M25), in the settings screen that pushes it (the screen
 * shows the intro): the web-trust callout, YOUR DEVICES as rows that open the device sheet (M26),
 * the hint, the signed-out devices, and "Link a new device" docked at the foot. The page gives the
 * own devices (`useOwnDevices`).
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
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [now] = useState(Date.now)
  const active = devices?.filter((d) => d.status !== 'revoked') ?? []
  const removed = devices?.filter((d) => d.status === 'revoked') ?? []
  // The sheet keeps its device while it slides out.
  const shown = useLatched(devices?.find((d) => d.id === openId))

  return (
    <div ref={setRoot} className="flex flex-col gap-3">
      <WebTrustCallout devices={devices} desktopAppUrl={`${takusenService.env.issuerOrigin}/`} />

      <SectionLabel className="pt-2">Your devices{devices && ` · ${active.length}`}</SectionLabel>
      {error && (
        <p
          role="alert"
          className="text-feature-danger-text text-[13.5px] leading-[18px] font-semibold"
        >
          {error}
        </p>
      )}
      {devices === null && !error && <p className={NOTE}>Loading…</p>}
      {active.length > 0 && (
        <ListGroup>
          {active.map((d) => (
            <DeviceButton key={d.id} device={d} now={now} onOpen={() => setOpenId(d.id)} />
          ))}
        </ListGroup>
      )}
      {active.length > 0 && <p className={NOTE}>Tap a device to rename it or sign it out.</p>}

      {removed.length > 0 && (
        <>
          <SectionLabel className="pt-2">Signed-out devices</SectionLabel>
          <ListGroup>
            {removed.map((d) => (
              <ListRow
                key={d.id}
                icon={<DeviceGlyph platform={d.platform} />}
                tile="neutral"
                label={d.name}
                detail={PLATFORM_LABEL[d.platform]}
              />
            ))}
          </ListGroup>
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
 * One device row (M25): the 40 tile (this device in accent, a browser in gold), the name with
 * "This device", the app and when it was active, the chips, a chevron. The row opens the sheet.
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
    <button
      type="button"
      onClick={onOpen}
      className={cn(ROW, device.current && 'bg-accent-primary/5')}
    >
      <DeviceTile platform={device.platform} current={device.current} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-text-primary truncate text-[15px] leading-[18px] font-extrabold">
            {device.name}
          </span>
          {device.current && <Chip tone="accent">This device</Chip>}
        </span>
        <span className="text-text-tertiary truncate text-[12.5px] leading-[15px] font-medium">
          {deviceMeta(device, now)}
        </span>
        {(device.primary || pending) && (
          <span className="flex flex-wrap gap-1.5 pt-0.5">
            {device.primary && (
              <Chip tone="voice" icon={<KeyRound aria-hidden />}>
                Has security key
              </Chip>
            )}
            {pending && <Chip tone="event">Not linked</Chip>}
          </span>
        )}
      </span>
      <ChevronRight aria-hidden className="text-text-disabled size-[17px] shrink-0" />
    </button>
  )
}
