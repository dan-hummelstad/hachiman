import { MicOff, VolumeX } from 'lucide-react'
import type { VoiceState } from '@hachiman/client'
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
    <span className={cn('text-muted-foreground flex shrink-0 items-center gap-0.5', className)}>
      {state.selfStream && <LiveBadge />}
      {state.selfMute && <MicOff aria-label="Muted" className="size-3.5" />}
      {state.selfDeaf && <VolumeX aria-label="Deafened" className="size-3.5" />}
    </span>
  )
}

export function LiveBadge(): React.JSX.Element {
  return (
    <span className="bg-destructive text-destructive-foreground px-1 text-[10px] leading-4 font-bold">
      LIVE
    </span>
  )
}
