import { AudioLines, HeadphoneOff, LoaderCircle, MicOff } from 'lucide-react'
import type { VoiceState } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { UserProfilePopover } from '@/components/user-profile-popover'
import type { CallParticipant } from '@/components/voice/call-roster'
import { useLayout } from '@/hooks/use-layout'
import { LONG_PRESS_TARGET, useLongPress } from '@/hooks/use-long-press'
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

/** The name pill of a full tile on the mobile layout (M10): 28 high at 10/10, name 13.5/800. */
const MOBILE_NAME_TAG =
  'mobile:top-2.5 mobile:left-2.5 mobile:h-7 mobile:max-w-[calc(100%-1.25rem)] mobile:bg-surface-window/70 mobile:py-0 mobile:pr-2.5 mobile:pl-2 mobile:text-[13.5px] mobile:font-extrabold'

/**
 * The speaker on the mobile layout (M10): a 2 px voice border, the voice tint and a soft glow on
 * the tile, a 3 px voice ring round the avatar.
 */
const MOBILE_SPEAKING =
  'mobile:bg-feature-voice/8 mobile:border-2 mobile:shadow-[0_0_24px_color-mix(in_srgb,var(--feature-voice)_25%,transparent)] mobile:ring-0'
const MOBILE_SPEAKING_AVATAR =
  'mobile:rounded-full mobile:outline-3 mobile:outline-feature-voice mobile:outline-solid'

/**
 * One person on the stage: avatar in the centre, name tag top-left, coral mute and deafen badges
 * top-right, and a green ring while they speak. A tile that is not yet (or no longer) in the
 * call's MLS tree shows dimmed with its status. A tap opens the profile (a sheet on the mobile
 * layout, with the volume of this person in my call). With `onHold`, a touch hold opens what the
 * owner shows for it (the member sheet).
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
  // M10: a full tile on the phone carries an 8% wash of the person's colour; the speaker's voice
  // tint replaces it. A variable, so the press fill still wins.
  const wash = mobile && !compact && !speaking
  return (
    <li className={cn('flex min-h-0', compact ? 'size-36 shrink-0' : 'min-h-40')}>
      <UserProfilePopover userId={userId} guildId={guildId} side="bottom">
        <button
          type="button"
          {...(onHold ? press : {})}
          style={
            wash
              ? ({
                  '--tile-wash': `color-mix(in oklab, ${ink ?? 'var(--text-tertiary)'} 8%, transparent)`
                } as React.CSSProperties)
              : undefined
          }
          className={cn(
            TILE,
            wash && 'bg-(color:--tile-wash)',
            'hover:bg-surface-hover mobile:active:bg-surface-hover flex size-full flex-col items-center justify-center gap-3 transition-colors outline-none focus-visible:outline-2 focus-visible:-outline-offset-2',
            !compact && 'mobile:gap-3.5',
            onHold && LONG_PRESS_TARGET,
            speaking && 'border-feature-voice ring-feature-voice ring-1 ring-inset',
            speaking && !compact && MOBILE_SPEAKING,
            pending && 'opacity-60'
          )}
        >
          <TileNameTag className={compact ? 'top-2 left-2 text-xs' : MOBILE_NAME_TAG}>
            {speaking && <AudioLines className="text-feature-voice-text size-3.5 shrink-0" />}
            <span className="truncate" style={ink ? { color: ink } : undefined}>
              {name}
            </span>
            {self && (
              <span className="text-text-tertiary mobile:text-xs mobile:font-semibold font-medium">
                you
              </span>
            )}
          </TileNameTag>
          {state && (state.selfMute || state.selfDeaf || state.mute || state.deaf) && (
            <span
              className={cn(
                'absolute flex gap-1',
                compact
                  ? 'top-2 right-2'
                  : 'mobile:top-2.5 mobile:right-2.5 mobile:gap-1.5 top-3 right-3'
              )}
            >
              {(state.selfMute || state.mute) && (
                <TileBadge
                  label={state.mute ? 'Server muted' : 'Muted'}
                  server={state.mute}
                  touch={!compact}
                >
                  <MicOff />
                </TileBadge>
              )}
              {(state.selfDeaf || state.deaf) && (
                <TileBadge
                  label={state.deaf ? 'Server deafened' : 'Deafened'}
                  server={state.deaf}
                  touch={!compact}
                >
                  <HeadphoneOff />
                </TileBadge>
              )}
            </span>
          )}
          <UserAvatar
            name={name}
            avatar={member?.user.avatar}
            color={ink}
            size={compact ? 56 : mobile ? 80 : 92}
            className={speaking && !compact ? MOBILE_SPEAKING_AVATAR : undefined}
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

/**
 * `server`: a server mute or deafen, on a solid red tile. `touch`: 28 with a 15 icon on the mobile
 * layout (M10).
 */
function TileBadge({
  label,
  server = false,
  touch = false,
  children
}: {
  label: string
  server?: boolean
  touch?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'flex size-6 items-center justify-center [&_svg]:size-3.5',
        touch && 'mobile:size-7 mobile:[&_svg]:size-[15px]',
        server
          ? 'bg-feature-danger text-text-on-accent'
          : cn(
              'bg-feature-danger/20 text-feature-danger-text',
              touch && 'mobile:bg-feature-danger/18'
            )
      )}
    >
      {children}
    </span>
  )
}
