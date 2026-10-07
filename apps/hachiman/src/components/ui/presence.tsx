import type { PresenceStatus } from '@hachiman/client'
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

/** Circular presence dot. The label is its accessible name, so colour is never the only cue. */
function PresenceDot({
  status,
  className
}: {
  status: PresenceStatus
  className?: string
}): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={PRESENCE_LABEL[status]}
      data-slot="presence-dot"
      data-status={status}
      className={cn('relative inline-block size-2 shrink-0 rounded-full', COLOR[status], className)}
    />
  )
}

export { PresenceDot }
