import { useMemo } from 'react'
import { Activity, Check, Eye, Info, PhoneCall, Volume2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Permissions, has } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { SystemTag } from '@/components/ui/system-tag'
import { useCallSecurity } from '@/components/voice/use-call-security'
import { usePermissions } from '@/hooks/use-hachiman'
import { useMemberView } from '@/hooks/use-member'
import { activeCalls, type ActiveCall } from '@/lib/active-now'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { openChannel } from '@/stores/navStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

const MAX_FACES = 6

/**
 * "Active now" (E1): the voice channels with people in them, across the guilds I share. The
 * gateway sends voice states only for my guilds. My own call says so. A live call shows the
 * streamer's avatar on the live tint (decision 4: no frame outside the call) and "Watch" (N18,
 * a muted join). Other calls show "Join".
 */
export function ActiveNow(): React.JSX.Element {
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
  const myCallName = myChannelId ? (channels.get(myChannelId)?.name ?? null) : null
  const joinable = calls.some((c) => !c.withMe)

  return (
    <aside
      aria-label="Active now"
      className={cn(
        'bg-surface-panel border-line-hairline hidden h-full min-h-0 w-[252px] shrink-0 flex-col border-l lg:flex',
        ROLE_INK_SCOPE
      )}
    >
      <div className="border-line-hairline flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-text-primary flex-1 text-[15px] font-extrabold">Active now</h2>
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
  const canConnect = has(usePermissions(call.guildId, call.channelId), Permissions.CONNECT)
  const { kind } = useCallSecurity()
  const blocked = !canConnect || kind === 'update_required' || kind === 'resyncing'
  const channel = useChannelStore((s) => s.channels.get(call.channelId))
  const join = (muted: boolean): void => {
    if (channel) void voiceService.join(channel, { muted })
  }
  const streamerId = call.withMe ? null : call.streamerId

  return (
    <section
      aria-label={`${call.channelName} in ${call.guildName}`}
      className={cn(
        'flex flex-col gap-2.5 border p-2.5',
        call.withMe
          ? 'border-feature-voice/40 bg-feature-voice/10'
          : 'border-line-hairline bg-surface-content'
      )}
    >
      <button
        type="button"
        onClick={() => openChannel(call.guildId, call.channelId)}
        className="focus-visible:outline-line-focus flex min-w-0 items-center gap-1.5 text-left focus-visible:outline-2"
      >
        <Volume2 className="text-feature-voice-text size-3.5 shrink-0" aria-hidden />
        <span className="text-text-primary truncate text-sm font-bold hover:underline">
          {call.channelName}
        </span>
        <span className="text-text-tertiary truncate text-xs">· {call.guildName}</span>
      </button>

      {streamerId !== null ? (
        <LiveBlock call={call} streamerId={streamerId} />
      ) : (
        <Faces guildId={call.guildId} userIds={call.userIds} />
      )}

      {call.withMe ? (
        <p className="text-feature-voice-text flex items-center gap-1.5 text-xs font-semibold">
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

/** The streamer's avatar on the live tint, "<name> is live", the channel and the count. */
function LiveBlock({
  call,
  streamerId
}: {
  call: ActiveCall
  streamerId: string
}): React.JSX.Element {
  const { name, avatar, ink } = useMemberView(call.guildId, streamerId)
  return (
    <div className="flex flex-col gap-2">
      <div className="bg-feature-danger/10 border-feature-danger/30 relative flex aspect-video items-center justify-center border">
        <SystemTag kind="live" className="absolute top-1.5 left-1.5" />
        <UserAvatar
          avatar={avatar}
          name={name}
          color={ink}
          size={48}
          className="ring-feature-danger/40 rounded-full ring-4"
        />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <UserAvatar avatar={avatar} name={name} color={ink} size={24} />
        <span className="flex min-w-0 flex-col">
          <span className="text-text-primary truncate text-[13px] font-bold">{name} is live</span>
          <span className="text-text-tertiary truncate text-xs">
            {call.channelName} · {call.userIds.length - 1} watching
          </span>
        </span>
      </div>
    </div>
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
  const { name, avatar, ink } = useMemberView(guildId, userId)
  return (
    <li title={name} className={cn(!first && '-ml-1.5')}>
      <UserAvatar
        avatar={avatar}
        name={name}
        color={ink}
        size={26}
        className="ring-surface-content rounded-full ring-2"
      />
    </li>
  )
}
