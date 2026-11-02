import type { PresenceStatus } from '@hachiman/client'

const WORD: Record<PresenceStatus, string | null> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: null
}

/** The presence as a mono word (ONLINE, IDLE, DO NOT DISTURB); nothing while offline. */
export function PresenceWord({ status }: { status: PresenceStatus }): React.JSX.Element | null {
  const word = WORD[status]
  if (!word) return null
  return (
    <span className="text-text-disabled shrink-0 font-mono text-[8.5px] tracking-[1px] uppercase">
      {word}
    </span>
  )
}
