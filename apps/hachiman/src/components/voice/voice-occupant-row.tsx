import { HeadphoneOff, MicOff, MonitorUp } from 'lucide-react'
import type { VoiceState } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { SystemTag } from '@/components/ui/system-tag'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { occupantDetail } from '@/components/voice/voice-occupant-text'
import { ServerMark } from '@/components/voice/voice-state-badges'
import { useLayout } from '@/hooks/use-layout'
import { usePresence, useSpeakingMember } from '@/hooks/use-member'
import { cn } from '@/lib/utils'

/**
 * The row height: 26 under a voice channel in the sidebar (36 on the mobile layout), 56 in the
 * occupant list of a voice channel I am not in (M64, mobile only).
 */
export type VoiceOccupantSize = 26 | 56

/**
 * A person in a voice channel, from the gateway voice state (no MLS tree outside the own call).
 * A tap opens the profile card (a sheet on the mobile layout). Needs a ROLE_INK_SCOPE ancestor for
 * the role ink of the name.
 */
export function VoiceOccupantRow({
  guildId,
  state,
  size
}: {
  guildId: string
  state: VoiceState
  size: VoiceOccupantSize
}): React.JSX.Element {
  return size === 26 ? (
    <SidebarOccupant guildId={guildId} state={state} />
  ) : (
    <ListOccupant guildId={guildId} state={state} />
  )
}

/** The LIVE tag and the mute and deafen marks, after the name. */
function VoiceMarks({
  state,
  iconClass,
  liveClass
}: {
  state: VoiceState
  iconClass: string
  liveClass?: string
}): React.JSX.Element {
  return (
    <>
      {state.selfStream && <SystemTag kind="live" className={liveClass} />}
      {state.mute ? (
        <ServerMark label="Server muted" icon={<MicOff />} />
      ) : (
        state.selfMute && (
          <MicOff aria-label="Muted" className={cn('text-feature-danger shrink-0', iconClass)} />
        )
      )}
      {state.deaf ? (
        <ServerMark label="Server deafened" icon={<HeadphoneOff />} />
      ) : (
        state.selfDeaf && (
          <HeadphoneOff
            aria-label="Deafened"
            className={cn('text-feature-danger shrink-0', iconClass)}
          />
        )
      )}
    </>
  )
}

/** The sidebar row: 26 high (36 with a 22 avatar on the mobile layout), indent 34. */
function SidebarOccupant({
  guildId,
  state
}: {
  guildId: string
  state: VoiceState
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const { member, name, ink, speaking } = useSpeakingMember(guildId, state.userId)
  return (
    <li>
      <UserProfilePopover userId={state.userId} guildId={guildId}>
        <button
          type="button"
          className={cn(
            'hover:bg-surface-hover rounded-control mobile:h-9 flex h-[26px] w-full items-center gap-2 pr-2 pl-[34px] text-left text-[14px]',
            speaking ? 'text-text-primary font-semibold' : 'text-text-secondary'
          )}
        >
          <UserAvatar
            name={name}
            avatar={member?.user.avatar}
            color={ink}
            size={mobile ? 22 : 20}
            speaking={speaking}
          />
          <span className="flex-1 truncate" style={ink ? { color: ink } : undefined}>
            {name}
          </span>
          <VoiceMarks state={state} iconClass="size-3.5" />
        </button>
      </UserProfilePopover>
    </li>
  )
}

/**
 * The list row of M64: 56 high, avatar 32 with the presence dot (the purple live dot while they
 * share), the name in role ink, a detail line ("Sharing screen · muted"), then the marks. The
 * detail line says what the marks show, so the marks stay out of the button's name.
 */
function ListOccupant({
  guildId,
  state
}: {
  guildId: string
  state: VoiceState
}): React.JSX.Element {
  const { member, name, ink, speaking } = useSpeakingMember(guildId, state.userId)
  const status = usePresence(state.userId)
  const detail = occupantDetail(state)
  return (
    <li>
      <UserProfilePopover userId={state.userId} guildId={guildId}>
        <button
          type="button"
          className="active:bg-surface-hover focus-visible:outline-line-focus flex h-14 w-full items-center gap-3 pr-3.5 pl-3 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          <UserAvatar
            name={name}
            avatar={member?.user.avatar}
            color={ink}
            size={32}
            status={status}
            live={state.selfStream}
            speaking={speaking}
            ringHole
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              className="text-text-primary truncate text-[15px] leading-[18px] font-bold"
              style={ink ? { color: ink } : undefined}
            >
              {name}
            </span>
            {detail !== null && (
              <span className="text-text-tertiary flex min-w-0 items-center gap-[5px] text-[12.5px] leading-[15px] font-medium">
                {state.selfStream && (
                  <MonitorUp className="text-status-live size-[13px] shrink-0" aria-hidden />
                )}
                <span className="truncate">{detail}</span>
              </span>
            )}
          </span>
          <span aria-hidden className="flex shrink-0 items-center gap-3">
            <VoiceMarks
              state={state}
              iconClass="size-4"
              liveClass="order-last h-[22px] px-[7px] text-[11px]"
            />
          </span>
        </button>
      </UserProfilePopover>
    </li>
  )
}
