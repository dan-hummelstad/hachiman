import { MicOff, VolumeX } from 'lucide-react'
import type { VoiceState } from '@hachiman/client'
import { cn } from '@/lib/utils'

/** Muted / deafened icons for a voice occupant; renders nothing when neither. */
export function VoiceStateBadges({
  state,
  className
}: {
  state: VoiceState
  className?: string
}): React.JSX.Element | null {
  if (!state.selfMute && !state.selfDeaf) return null
  return (
    <span className={cn('text-muted-foreground flex shrink-0 items-center gap-0.5', className)}>
      {state.selfMute && <MicOff aria-label="Muted" className="size-3.5" />}
      {state.selfDeaf && <VolumeX aria-label="Deafened" className="size-3.5" />}
    </span>
  )
}
