import { MonitorSmartphone } from 'lucide-react'
import type { DevicePlatform } from '@hachiman/crypto'
import { PLATFORM_ICON } from '@/lib/device-platform'
import { cn } from '@/lib/utils'

/**
 * The icon of the kind of app that a device runs. Null (not known): a generic device. Decorative
 * unless `label` is set.
 */
export function DeviceGlyph({
  platform,
  label,
  className
}: {
  platform: DevicePlatform | null
  label?: string
  className?: string
}): React.JSX.Element {
  const Icon = platform ? PLATFORM_ICON[platform] : MonitorSmartphone
  return label ? (
    <Icon aria-label={label} className={className} />
  ) : (
    <Icon aria-hidden className={className} />
  )
}

export type DeviceTileTone = 'accent' | 'event' | 'neutral'

/**
 * The tone of a device tile. The tones keep their names, but every tile is neutral now: a device
 * is not an answer to one of the three questions.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function deviceTileTone(device: {
  platform: DevicePlatform | null
  current?: boolean
}): DeviceTileTone {
  if (device.current) return 'accent'
  return device.platform === 'browser' ? 'event' : 'neutral'
}

const TONE: Record<DeviceTileTone, string> = {
  accent: 'bg-surface-raised text-text-secondary',
  event: 'bg-surface-raised text-text-secondary',
  neutral: 'bg-surface-raised text-text-secondary'
}

/**
 * The 40 square tile of a device with its platform icon (19). Decorative: the row around it says
 * the name and the platform.
 */
export function DeviceTile({
  platform,
  current,
  className
}: {
  platform: DevicePlatform | null
  /** The device that runs this app. */
  current?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      data-slot="device-tile"
      className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-[10px] [&_svg]:size-[19px]',
        TONE[deviceTileTone({ platform, current })],
        className
      )}
    >
      <DeviceGlyph platform={platform} />
    </span>
  )
}
