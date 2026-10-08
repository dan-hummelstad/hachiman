import { HeadphoneOff, MicOff } from 'lucide-react'
import type { VoiceState } from '@hachiman/client'
import { SystemTag } from '@/components/ui/system-tag'
import { cn } from '@/lib/utils'

/**
 * LIVE / muted / deafened marks for a voice occupant; renders nothing when none apply. A server
 * mute or deafen (§6 "Voice moderation") shows on a red tile instead of the self mark.
 */
export function VoiceStateBadges({
  state,
  className
}: {
  state: VoiceState
  className?: string
}): React.JSX.Element | null {
  if (!state.selfMute && !state.selfDeaf && !state.selfStream && !state.mute && !state.deaf)
    return null
  return (
    <span className={cn('text-feature-danger-text flex shrink-0 items-center gap-1', className)}>
      {state.selfStream && <SystemTag kind="live" />}
      {state.mute ? (
        <ServerMark label="Server muted" icon={<MicOff />} />
      ) : (
        state.selfMute && <MicOff aria-label="Muted" className="size-3.5" />
      )}
      {state.deaf ? (
        <ServerMark label="Server deafened" icon={<HeadphoneOff />} />
      ) : (
        state.selfDeaf && <HeadphoneOff aria-label="Deafened" className="size-3.5" />
      )}
    </span>
  )
}

/** A server mute or deafen: white icon on a red tile, so it reads apart from the self mark. */
export function ServerMark({
  label,
  icon
}: {
  label: string
  icon: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="bg-feature-danger text-text-on-accent rounded-control inline-flex size-4 shrink-0 items-center justify-center [&_svg]:size-3"
    >
      {icon}
    </span>
  )
}
