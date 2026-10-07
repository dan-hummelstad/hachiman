import { HeadphoneOff, MicOff } from 'lucide-react'
import type { VoiceState } from '@hachiman/client'
import { SystemTag } from '@/components/ui/system-tag'
import { cn } from '@/lib/utils'

/** LIVE / muted / deafened marks for a voice occupant; renders nothing when none apply. */
export function VoiceStateBadges({
  state,
  className
}: {
  state: VoiceState
  className?: string
}): React.JSX.Element | null {
  if (!state.selfMute && !state.selfDeaf && !state.selfStream) return null
  return (
    <span className={cn('text-feature-danger-text flex shrink-0 items-center gap-1', className)}>
      {state.selfStream && <SystemTag kind="live" />}
      {state.selfMute && <MicOff aria-label="Muted" className="size-3.5" />}
      {state.selfDeaf && <HeadphoneOff aria-label="Deafened" className="size-3.5" />}
    </span>
  )
}
