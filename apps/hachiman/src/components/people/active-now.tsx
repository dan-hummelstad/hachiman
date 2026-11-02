import { useId, useMemo } from 'react'
import { Activity, Check, Eye, Info, PhoneCall, Volume2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { SectionLabel } from '@/components/mobile/list'
import { AvatarRow, UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { LiveCard } from '@/components/voice/live-card'
import { useCanJoinVoice } from '@/components/voice/use-call-security'
import { useMemberView } from '@/hooks/use-member'
import { activeCalls, type ActiveCall } from '@/lib/active-now'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { openChannel } from '@/stores/navStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

const MAX_FACES = 6

/** The voice channels with people in them that the viewer sees, and the viewer's own call. */
function useActiveCalls(): { calls: ActiveCall[]; myChannelId: string | null } {
  const { voiceStates, myChannelId } = useVoiceStore(
    useShallow((s) => ({ voiceStates: s.voiceStates, myChannelId: s.channelId }))
  )
  const channels = useChannelStore((s) => s.channels)
  const guilds = useGuildStore((s) => s.guilds)
  const myId = useUserStore((s) => s.me?.id ?? null)
  const calls = useMemo(
    () => activeCalls(voiceStates, channels, guilds, myId, myChannelId),
    [voiceStates, channels, guilds, myId, myChannelId]
  )
  return { calls, myChannelId }
}

/**
 * "Active now" (E1): the voice channels with people in them, across the guilds I share. The
 * gateway sends voice states only for my guilds. My own call says so. A live call shows the
 * streamer's avatar on the live tint (decision 4: no frame outside the call) and "Watch" (N18,
 * a muted join). Other calls show "Join".
 */
export function ActiveNow(): React.JSX.Element {
  const { calls, myChannelId } = useActiveCalls()
  const myCallName = useChannelStore((s) =>
    myChannelId ? (s.channels.get(myChannelId)?.name ?? null) : null
  )
  const joinable = calls.some((c) => !c.withMe)

  return (
    <aside
      aria-label="Active now"
      className="bg-surface-panel border-line-hairline hidden h-full min-h-0 w-[252px] shrink-0 flex-col border-l lg:flex"
    >
      <div className="border-line-hairline flex h-[52px] shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-text-primary flex-1 text-[15px] font-semibold">Active now</h2>
        <Activity className="text-text-tertiary size-4" aria-hidden />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">
        {calls.length === 0 ? (
          <p className="text-text-tertiary px-2 py-8 text-center text-[13px] leading-5">
            It&apos;s quiet for now. When someone joins a voice channel, it shows here.
          </p>
        ) : (
          calls.map((c) => <CallCard key={c.channelId} call={c} />)
        )}
        {myCallName !== null && joinable && (
          <p className="text-text-tertiary flex gap-1.5 px-1 text-xs leading-4">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            You&apos;re in {myCallName}. Joining moves your call there.
          </p>
        )}
      </div>
    </aside>
  )
}

function CallCard({ call }: { call: ActiveCall }): React.JSX.Element {
  const blocked = !useCanJoinVoice(call.guildId, call.channelId)
  const channel = useChannelStore((s) => s.channels.get(call.channelId))
  const join = (muted: boolean): void => {
    if (channel) void voiceService.join(channel, { muted })
  }
  const streamerId = call.withMe ? null : call.streamerId

  return (
    <section
      aria-label={`${call.channelName} in ${call.guildName}`}
      className={cn(
        'rounded-option flex flex-col gap-2.5 border p-2.5',
        call.withMe ? 'border-live-line bg-live-tint' : 'border-line-hairline bg-surface-content'
      )}
    >
      <button
        type="button"
        onClick={() => openChannel(call.guildId, call.channelId)}
        className="focus-visible:outline-line-focus flex min-w-0 items-center gap-1.5 text-left focus-visible:outline-2"
      >
        <Volume2 className="text-live-text size-3.5 shrink-0" aria-hidden />
        <span className="text-text-primary truncate text-sm font-semibold hover:underline">
          {call.channelName}
        </span>
        <span className="text-text-tertiary truncate text-xs">· {call.guildName}</span>
      </button>

      {streamerId !== null ? (
        <LiveCard
          guildId={call.guildId}
          userId={streamerId}
          channelName={call.channelName}
          watching={call.userIds.length - 1}
          size="md"
        />
      ) : (
        <Faces guildId={call.guildId} userIds={call.userIds} />
      )}

      {call.withMe ? (
        <p className="text-live-text flex items-center gap-1.5 text-xs font-semibold">
          <Check className="size-3.5" aria-hidden />
          You&apos;re in this call
        </p>
      ) : streamerId !== null ? (
        <Button variant="secondary" disabled={blocked} onClick={() => join(true)}>
          <Eye />
          Watch
        </Button>
      ) : (
        <Button variant="voice" disabled={blocked} onClick={() => join(false)}>
          <PhoneCall />
          Join
        </Button>
      )}
    </section>
  )
}

function Faces({ guildId, userIds }: { guildId: string; userIds: string[] }): React.JSX.Element {
  const shown = userIds.slice(0, MAX_FACES)
  const more = userIds.length - shown.length
  return (
    <ul className="flex items-center">
      {shown.map((id, i) => (
        <Face key={id} guildId={guildId} userId={id} first={i === 0} />
      ))}
      {more > 0 && (
        <li className="text-text-tertiary pl-1.5 text-xs font-semibold tabular-nums">+{more}</li>
      )}
    </ul>
  )
}

function Face({
  guildId,
  userId,
  first
}: {
  guildId: string
  userId: string
  first: boolean
}): React.JSX.Element {
  const { name, avatar } = useMemberView(guildId, userId)
  return (
    <li title={name} className={cn(!first && '-ml-1.5')}>
      <UserAvatar avatar={avatar} name={name} size={26} className="ring-surface-content ring-2" />
    </li>
  )
}

/** The faces of a strip card: 26, overlapping by 5. */
const STRIP_FACE = 26
const STRIP_MAX_FACES = 6

/**
 * ACTIVE NOW on the mobile DM home (M56): a row of 212 x 112 cards that scrolls sideways and
 * snaps, one per call. The whole card opens the channel; there it can be joined. A live call shows
 * the streamer's avatar on the live tint, never a frame of the stream. Nothing when no one is in a
 * call.
 */
export function ActiveNowStrip(): React.JSX.Element | null {
  const { calls } = useActiveCalls()
  const labelId = useId()
  if (calls.length === 0) return null
  return (
    <section aria-labelledby={labelId} className="flex flex-col gap-2.5">
      <SectionLabel id={labelId} className="px-4 pt-0.5">
        Active now
      </SectionLabel>
      <ul
        data-swipe-ignore
        className="flex snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto overscroll-x-contain px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {calls.map((c) => (
          <li key={c.channelId} className="shrink-0 snap-start">
            <StripCard call={c} />
          </li>
        ))}
      </ul>
    </section>
  )
}

const STRIP_TONE = {
  mine: 'border-live-line bg-live-tint gap-2.5 p-3',
  live: 'border-live-line bg-live-tint gap-2 p-2',
  other: 'border-line-hairline bg-surface-raised gap-2.5 p-3'
} as const

function StripCard({ call }: { call: ActiveCall }): React.JSX.Element {
  const streamerId = call.withMe ? null : call.streamerId
  const streamer = useMemberView(call.guildId, streamerId ?? call.userIds[0] ?? '')
  const tone = call.withMe ? 'mine' : streamerId !== null ? 'live' : 'other'
  const people = call.userIds.length
  const state = call.withMe
    ? "you're in this call"
    : streamerId !== null
      ? `${streamer.name} is live`
      : `${people} ${people === 1 ? 'person' : 'people'}`

  return (
    <button
      type="button"
      onClick={() => openChannel(call.guildId, call.channelId)}
      aria-label={`${call.channelName}, ${call.guildName}, ${state}`}
      className={cn(
        'rounded-option flex h-28 w-[212px] flex-col overflow-hidden border text-left outline-none active:opacity-80',
        'focus-visible:outline-line-focus focus-visible:outline-2 focus-visible:-outline-offset-2',
        STRIP_TONE[tone]
      )}
    >
      {streamerId !== null ? (
        <LiveCard
          guildId={call.guildId}
          userId={streamerId}
          channelName={call.channelName}
          watching={people - 1}
          size="strip"
        />
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            <Volume2 className="text-live-text size-[15px] shrink-0" aria-hidden />
            <span className="text-text-primary truncate text-sm leading-[17px] font-semibold">
              {call.channelName}
            </span>
            <span className="text-text-tertiary truncate text-[12.5px] leading-[15px] font-semibold">
              · {call.guildName}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <AvatarRow size={STRIP_FACE} overlap={5}>
              {call.userIds.slice(0, STRIP_MAX_FACES).map((id) => (
                <StripFace key={id} guildId={call.guildId} userId={id} />
              ))}
            </AvatarRow>
            {people > STRIP_MAX_FACES && (
              <span className="text-text-tertiary text-xs font-semibold tabular-nums">
                +{people - STRIP_MAX_FACES}
              </span>
            )}
          </span>
          {call.withMe && (
            <span className="text-live-text flex items-center gap-[5px] text-[12.5px] leading-[15px] font-semibold">
              <Check className="size-[13px]" aria-hidden />
              You&apos;re in this call
            </span>
          )}
        </>
      )}
    </button>
  )
}

function StripFace({ guildId, userId }: { guildId: string; userId: string }): React.JSX.Element {
  const { name, avatar } = useMemberView(guildId, userId)
  return <UserAvatar avatar={avatar} name={name} size={STRIP_FACE} />
}
