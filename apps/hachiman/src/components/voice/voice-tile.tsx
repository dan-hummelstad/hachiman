import { HeadphoneOff, LoaderCircle, MicOff, MonitorUp } from 'lucide-react'
import type { VoiceState } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { UserProfilePopover } from '@/components/user-profile-popover'
import type { CallParticipant } from '@/components/voice/call-roster'
import { useLayout } from '@/hooks/use-layout'
import { LONG_PRESS_TARGET, useLongPress } from '@/hooks/use-long-press'
import { useSpeakingMember } from '@/hooks/use-member'
import { STATE_LINE, TILE, TILE_SPEAKING } from '@/components/voice/voice-tile-styles'
import { cn } from '@/lib/utils'

/** The name tag over a stream (the share's frame). */
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
        'bg-surface-window/85 rounded-badge text-text-primary pointer-events-none absolute top-3 left-3 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 px-2 py-1 text-[12px] leading-4 font-semibold',
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

const BAR_HEIGHTS = [
  'h-[5px] mobile:h-1',
  'h-[10px] mobile:h-2',
  'h-[7px] mobile:h-[5px]',
  'h-3 mobile:h-[9px]',
  'h-[6px] mobile:h-1'
]

/** Five live bars that pulse while someone speaks. */
export function SpeakingBars({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn('flex h-3 items-end gap-0.5 motion-safe:animate-pulse', className)}
    >
      {BAR_HEIGHTS.map((h) => (
        <span key={h} className={cn('bg-live w-0.5 rounded-[1px]', h)} />
      ))}
    </span>
  )
}

/** The state line under a tile name, first match wins. */
function TileState({
  state,
  status,
  speaking,
  self,
  compact,
  mobile
}: {
  state: VoiceState | null
  status: TileStatus
  speaking: boolean
  self: boolean
  compact: boolean
  mobile: boolean
}): React.JSX.Element {
  // B5: a phone face has no state text, only the bars and a small muted mic.
  if (mobile && compact) {
    const muted = state !== null && (state.selfMute || state.mute)
    return (
      <span className="flex h-3 items-center gap-1">
        {speaking && <SpeakingBars />}
        {muted && (
          <MicOff
            aria-label={state.mute ? 'Server muted' : 'Muted'}
            className={cn('size-[11px]', self ? 'text-you' : 'text-text-disabled')}
          />
        )}
      </span>
    )
  }
  let icon: React.ReactNode = null
  let label: React.ReactNode = null
  let tone = ''
  if (status !== null && status !== 'secure') {
    icon = status === 'joining' ? <LoaderCircle className="animate-spin" aria-hidden /> : null
    label = STATUS_LABEL[status]
  } else if (speaking) {
    icon = <SpeakingBars />
    label = <span className="text-live-text font-semibold">Speaking</span>
  } else if (state?.mute) {
    icon = <MicOff aria-hidden />
    label = 'Server muted'
  } else if (state?.deaf) {
    icon = <HeadphoneOff aria-hidden />
    label = 'Server deafened'
  } else if (state?.selfDeaf) {
    icon = <HeadphoneOff aria-hidden />
    label = 'Deafened'
  } else if (state?.selfMute) {
    icon = <MicOff aria-hidden />
    label = self ? 'You are muted' : 'Muted'
    // B4: on the phone, my own muted mic is a thing to regret, so it takes `you`.
    if (self) tone = 'mobile:text-you-text mobile:font-semibold mobile:[&_svg]:text-you'
  } else if (state?.selfStream) {
    icon = <MonitorUp aria-hidden />
    label = 'Sharing screen'
  }
  return (
    <span
      className={cn(STATE_LINE, tone, label === null && 'h-3')}
      title={typeof label === 'string' ? label : undefined}
    >
      {icon}
      {label}
    </span>
  )
}

/**
 * One person on the stage: a centred avatar, the name, and a mono state line (speaking, muted,
 * sharing). The speaker's tile takes a 2 px live border. A tile that is not yet (or no longer) in
 * the call's MLS tree shows dimmed with its status. A tap opens the profile (a sheet on the
 * mobile layout, with the volume of this person in my call). With `onHold`, a touch hold opens
 * what the owner shows for it (the member sheet).
 */
export function ParticipantTile({
  guildId,
  userId,
  state,
  status,
  self,
  compact,
  onHold
}: {
  guildId: string | null
  userId: string
  state: VoiceState | null
  status: TileStatus
  self: boolean
  /** A small tile in the strip under live streams. */
  compact?: boolean
  /** Mobile layout: a touch hold on the tile. */
  onHold?: (userId: string) => void
}): React.JSX.Element {
  const { member, name, ink, speaking } = useSpeakingMember(guildId, userId)
  const mobile = useLayout() === 'mobile'
  const press = useLongPress(() => onHold?.(userId), { enabled: onHold !== undefined })
  const pending = status !== null && status !== 'secure'
  const small = compact === true
  return (
    <li
      className={cn(
        'flex min-h-0',
        small ? 'mobile:h-[104px] mobile:w-[84px] h-[146px] w-[205px] shrink-0' : 'min-h-40'
      )}
    >
      <UserProfilePopover userId={userId} guildId={guildId} side="bottom">
        <button
          type="button"
          {...(onHold ? press : {})}
          className={cn(
            TILE,
            small && 'rounded-control mobile:rounded-[14px]',
            'hover:bg-surface-hover mobile:active:bg-surface-hover flex size-full flex-col items-center justify-center gap-3.5 transition-colors outline-none focus-visible:outline-2 focus-visible:-outline-offset-2',
            small && 'mobile:gap-2',
            onHold && LONG_PRESS_TARGET,
            speaking && TILE_SPEAKING,
            pending && 'opacity-60'
          )}
        >
          <UserAvatar
            name={name}
            avatar={member?.user.avatar}
            color={ink}
            size={small ? (mobile ? 38 : 46) : mobile ? 58 : 76}
          />
          <span className="flex max-w-full flex-col items-center gap-1.5">
            <span
              className={cn(
                'text-text-primary max-w-full truncate px-3 font-semibold',
                small
                  ? 'mobile:text-[11.5px] mobile:text-text-secondary text-[13.5px]'
                  : 'mobile:text-[14px] text-[15px]'
              )}
            >
              {name}
              {self && <span className="text-text-tertiary font-normal"> · you</span>}
            </span>
            <TileState
              state={state}
              status={status}
              speaking={speaking}
              self={self}
              compact={small}
              mobile={mobile}
            />
          </span>
        </button>
      </UserProfilePopover>
    </li>
  )
}
