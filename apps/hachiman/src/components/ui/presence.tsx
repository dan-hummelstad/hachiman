import type { PresenceStatus } from '@hachiman/client'
import type { Hole } from '@/lib/tile-cutouts'
import { cn } from '@/lib/utils'

const COLOR: Record<PresenceStatus, string> = {
  online: 'bg-status-online',
  idle: 'bg-status-idle',
  dnd: 'bg-status-dnd',
  offline: 'bg-status-offline'
}

export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: 'Offline'
}

/** For my own status, offline is a choice: "Invisible". */
export const OWN_STATUS_LABEL: Record<PresenceStatus, string> = {
  ...PRESENCE_LABEL,
  offline: 'Invisible'
}

/** The drawn dot sizes of the mobile kit by avatar size (M8, M56, M7, M3). */
const DOT_BY_AVATAR: Readonly<Record<number, number>> = {
  24: 9,
  28: 10,
  30: 10,
  32: 11,
  40: 13,
  72: 24
}

/**
 * The mobile layout's presence ring: the cutout around the dot. The dot sticks out of the avatar's
 * box by `PRESENCE_OUTSET` at the bottom right.
 */
export const PRESENCE_RING = 2.5
export const PRESENCE_OUTSET = 1

/** The diameter of the presence dot on an avatar `avatar` px wide, on the mobile layout. */
export function presenceDotSize(avatar: number): number {
  return DOT_BY_AVATAR[avatar] ?? Math.max(8, Math.round(avatar / 3))
}

/**
 * The hole that the ring of the mobile presence dot cuts out of an avatar `avatar` px wide (for a
 * tinted or translucent surface behind it, `lib/tile-cutouts.ts`).
 */
export function presenceHole(avatar: number): Hole {
  const r = presenceDotSize(avatar) / 2
  const c = avatar + PRESENCE_OUTSET - r
  return [c, c, r + PRESENCE_RING]
}

/**
 * Circular presence dot. The label is its accessible name, so colour is never the only cue.
 * `live`: the purple streaming dot (`--status-live`, M56).
 */
function PresenceDot({
  status,
  live = false,
  className,
  style
}: {
  status: PresenceStatus
  live?: boolean
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={live ? 'Live' : PRESENCE_LABEL[status]}
      data-slot="presence-dot"
      data-status={live ? 'live' : status}
      style={style}
      className={cn(
        'relative inline-block size-2 shrink-0 rounded-full',
        live ? 'bg-status-live' : COLOR[status],
        className
      )}
    />
  )
}

export { PresenceDot }
