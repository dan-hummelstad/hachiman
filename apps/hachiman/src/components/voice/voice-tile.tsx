import { AudioLines, HeadphoneOff, LoaderCircle, MicOff } from 'lucide-react'
import type { VoiceState } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { UserProfilePopover } from '@/components/user-profile-popover'
import type { CallParticipant } from '@/components/voice/call-roster'
import { useSpeakingMember } from '@/hooks/use-member'
import { TILE } from '@/components/voice/voice-tile-styles'
import { cn } from '@/lib/utils'

/** The dark name tag in the top-left corner of a tile. */
export function TileNameTag({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'bg-surface-window/85 text-text-primary pointer-events-none absolute top-3 left-3 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 px-2 py-1 text-[13px] leading-4 font-bold',
        className
      )}
    >
      {children}
    </span>
  )
}

/** Null outside the own call: there is no tree state to show. */
export type TileStatus = CallParticipant['status'] | null

const STATUS_LABEL: Record<Exclude<TileStatus, 'secure' | null>, string> = {
  joining: 'Joining securely…',
  leaving: 'Leaving'
}

/**
 * One person on the stage: avatar in the centre, name tag top-left, coral mute and deafen badges
 * top-right, and a green ring while they speak. A tile that is not yet (or no longer) in the
 * call's MLS tree shows dimmed with its status.
 */
export function ParticipantTile({
  guildId,
  userId,
  state,
  status,
  self,
  compact
}: {
  guildId: string | null
  userId: string
  state: VoiceState | null
  status: TileStatus
  self: boolean
  /** A small tile in the strip under live streams. */
  compact?: boolean
}): React.JSX.Element {
  const { member, name, ink, speaking } = useSpeakingMember(guildId, userId)
  const pending = status !== null && status !== 'secure'
  return (
    <li className={cn('flex min-h-0', compact ? 'size-36 shrink-0' : 'min-h-40')}>
      <UserProfilePopover userId={userId} guildId={guildId} side="bottom">
        <button
          type="button"
          className={cn(
            TILE,
            'hover:bg-surface-hover flex size-full flex-col items-center justify-center gap-3 transition-colors outline-none focus-visible:outline-2 focus-visible:-outline-offset-2',
            speaking && 'border-feature-voice ring-feature-voice ring-1 ring-inset',
            pending && 'opacity-60'
          )}
        >
          <TileNameTag className={compact ? 'top-2 left-2 text-xs' : undefined}>
            {speaking && <AudioLines className="text-feature-voice-text size-3.5 shrink-0" />}
            <span className="truncate" style={ink ? { color: ink } : undefined}>
              {name}
            </span>
            {self && <span className="text-text-tertiary font-medium">you</span>}
          </TileNameTag>
          {state && (state.selfMute || state.selfDeaf || state.mute || state.deaf) && (
            <span
              className={cn('absolute flex gap-1', compact ? 'top-2 right-2' : 'top-3 right-3')}
            >
              {(state.selfMute || state.mute) && (
                <TileBadge label={state.mute ? 'Server muted' : 'Muted'} server={state.mute}>
                  <MicOff />
                </TileBadge>
              )}
              {(state.selfDeaf || state.deaf) && (
                <TileBadge label={state.deaf ? 'Server deafened' : 'Deafened'} server={state.deaf}>
                  <HeadphoneOff />
                </TileBadge>
              )}
            </span>
          )}
          <UserAvatar
            name={name}
            avatar={member?.user.avatar}
            color={ink}
            size={compact ? 56 : 92}
          />
          {pending && (
            <span className="text-text-secondary flex items-center gap-1 text-xs">
              {status === 'joining' && <LoaderCircle className="size-3 animate-spin" aria-hidden />}
              {STATUS_LABEL[status]}
            </span>
          )}
        </button>
      </UserProfilePopover>
    </li>
  )
}

/** `server`: a server mute or deafen, on a solid red tile. */
function TileBadge({
  label,
  server = false,
  children
}: {
  label: string
  server?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'flex size-6 items-center justify-center [&_svg]:size-3.5',
        server
          ? 'bg-feature-danger text-text-on-accent'
          : 'bg-feature-danger/20 text-feature-danger-text'
      )}
    >
      {children}
    </span>
  )
}
