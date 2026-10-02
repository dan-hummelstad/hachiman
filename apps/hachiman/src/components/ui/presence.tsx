import type { PresenceStatus } from '@hachiman/client'
import { cn } from '@/lib/utils'

// Shape + colour (spec §2): never colour alone.
const SHAPE: Record<PresenceStatus, string> = {
  online: 'bg-online',
  idle: 'border border-idle before:absolute before:inset-x-0 before:bottom-0 before:h-1/2 before:bg-idle',
  dnd: 'bg-dnd before:absolute before:inset-x-[1px] before:top-[3px] before:h-[2px] before:bg-white/90',
  offline: 'border-2 border-offline'
}

export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: 'Offline'
}

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
      className={cn('relative inline-block size-2 shrink-0', SHAPE[status], className)}
    />
  )
}

export { PresenceDot }
