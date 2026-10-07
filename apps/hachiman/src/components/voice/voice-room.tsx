import { useMemo } from 'react'
import { Info, PhoneCall, PhoneOff } from 'lucide-react'
import { Permissions, has, type VoiceState } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import { CallSecurityBanner } from '@/components/voice/call-security'
import { secureUserIds } from '@/components/voice/call-roster'
import { ScreenShareControls } from '@/components/voice/screen-share-controls'
import { SelfVoiceToggles } from '@/components/voice/self-voice-toggles'
import { LiveCard, StreamGrid } from '@/components/voice/stream-grid'
import { useCallParticipants, useCallSecurity } from '@/components/voice/use-call-security'
import { ParticipantTile, type TileStatus } from '@/components/voice/voice-tile'
import { stageColumns } from '@/components/voice/voice-tile-styles'
import { useChannelOccupants, usePermissions } from '@/hooks/use-hachiman'
import { useMemberView } from '@/hooks/use-member'
import { channelLabel, type GuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { useChannelStore } from '@/stores/channelStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * Body of a voice channel. In the own call: the stage (live screen shares, a tile per person) and
 * the floating control bar. Outside it: what happens in the channel and "Join voice". No messages.
 *
 * In the own call, the tiles come from the MLS tree (§12.10.1): a user that only the servers
 * report shows as joining. Outside the call, only the gateway voice states are known.
 */
export function VoiceRoom({ channel }: { channel: GuildChannel }): React.JSX.Element {
  const here = useVoiceStore((s) => s.channelId === channel.id)
  return here ? <Stage channel={channel} /> : <NotJoined channel={channel} />
}

interface Tile {
  userId: string
  state: VoiceState | null
  status: TileStatus
}

function Stage({ channel }: { channel: GuildChannel }): React.JSX.Element {
  const meId = useUserStore((s) => s.me?.id ?? null)
  const occupants = useChannelOccupants(channel.guildId, channel.id)
  const participants = useCallParticipants(channel.guildId, channel.id)
  const secure = useMemo(() => (participants ? secureUserIds(participants) : null), [participants])
  const tiles: Tile[] = (participants ?? []).map((p) => ({
    userId: p.userId,
    state: p.voiceState,
    status: p.status
  }))
  const streaming = occupants.some((vs) => vs.selfStream)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-6 pb-28">
        <StreamGrid guildId={channel.guildId} occupants={occupants} secure={secure} />
        <ul
          className={cn(
            streaming
              ? 'flex shrink-0 gap-3 overflow-x-auto'
              : cn('grid min-h-0 flex-1 auto-rows-fr gap-3', stageColumns(tiles.length))
          )}
        >
          {tiles.map((t) => (
            <ParticipantTile
              key={t.userId}
              guildId={channel.guildId}
              userId={t.userId}
              state={t.state}
              status={t.status}
              self={t.userId === meId}
              compact={streaming}
            />
          ))}
        </ul>
      </div>
      <ControlBar />
    </div>
  )
}

/** Bar buttons: 40 px, rounded, 18 px icons. Mute and deafen turn coral while on. */
const BAR_BUTTON =
  "size-10 text-text-secondary hover:bg-surface-hover hover:text-text-primary [&_svg:not([class*='size-'])]:size-[18px]"
const BAR_TOGGLE = cn(
  BAR_BUTTON,
  'bg-surface-hover text-text-primary aria-pressed:bg-feature-danger/15 aria-pressed:text-feature-danger-text hover:aria-pressed:text-feature-danger-text'
)
const BAR_SHARE = cn(
  BAR_BUTTON,
  'aria-pressed:bg-feature-voice/15 aria-pressed:text-feature-voice-text'
)

/** The one floating control bar of the stage: mic, deafen, share, stream settings, and Leave. */
function ControlBar(): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 flex flex-col items-center gap-2 px-4">
      <CallSecurityBanner className="pointer-events-auto w-full max-w-md" />
      <div className="pointer-events-auto flex items-center gap-3">
        <div
          role="toolbar"
          aria-label="Call controls"
          className="bg-surface-raised border-line-hairline shadow-soft flex items-center gap-1 border p-1.5"
        >
          <SelfVoiceToggles className={BAR_TOGGLE} />
          <ScreenShareControls buttonClassName={BAR_SHARE} />
        </div>
        <Button
          variant="danger"
          className="shadow-soft h-[52px] px-5 text-[15px]"
          onClick={() => voiceService.leaveVoice()}
        >
          <PhoneOff className="size-[18px]" />
          Leave
        </Button>
      </div>
    </div>
  )
}

/**
 * A voice channel the user is not in (D2). A live stream shows as the live card (decision 4: no
 * frame for non-members), else the people in the channel. Then "Join voice", and a note when the
 * join moves the user's call from another channel.
 */
function NotJoined({ channel }: { channel: GuildChannel }): React.JSX.Element {
  const occupants = useChannelOccupants(channel.guildId, channel.id)
  const canConnect = has(usePermissions(channel.guildId, channel.id), Permissions.CONNECT)
  const { kind } = useCallSecurity()
  const otherCallId = useVoiceStore((s) => s.channelId)
  const otherCallName = useChannelStore((s) =>
    otherCallId ? (s.channels.get(otherCallId)?.name ?? null) : null
  )
  const streamer = occupants.find((vs) => vs.selfStream) ?? null
  const channelName = channelLabel(channel).name

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto p-6">
      {streamer ? (
        <LiveCard
          guildId={channel.guildId}
          userId={streamer.userId}
          channelName={channelName}
          watching={occupants.length - 1}
        />
      ) : occupants.length > 0 ? (
        <ul
          className={cn(
            'grid w-full max-w-2xl gap-3',
            occupants.length === 1 ? 'max-w-xs grid-cols-1' : 'grid-cols-2 sm:grid-cols-3'
          )}
        >
          {occupants.map((vs) => (
            <ParticipantTile
              key={vs.userId}
              guildId={channel.guildId}
              userId={vs.userId}
              state={vs}
              status={null}
              self={false}
              compact
            />
          ))}
        </ul>
      ) : null}
      <h2 className="text-text-primary text-center text-lg font-extrabold">
        {streamer ? (
          <StreamerHeadline
            guildId={channel.guildId}
            userId={streamer.userId}
            channelName={channelName}
          />
        ) : occupants.length > 0 ? (
          `${occupants.length} in ${channelName}`
        ) : (
          `No one is in ${channelName} yet`
        )}
      </h2>
      <Button
        variant="voice"
        size="lg"
        disabled={!canConnect || kind === 'update_required' || kind === 'resyncing'}
        onClick={() => void voiceService.join(channel)}
      >
        <PhoneCall />
        Join voice
      </Button>
      {otherCallName !== null && canConnect && (
        <p className="text-text-tertiary flex items-center gap-1.5 text-[13px]">
          <Info className="size-3.5 shrink-0" aria-hidden />
          You&apos;re in {otherCallName}. Joining moves your call here.
        </p>
      )}
      {!canConnect && (
        <p className="text-text-tertiary text-[13px]">
          You don&apos;t have permission to join {channelName}.
        </p>
      )}
      <CallSecurityBanner className="w-full max-w-md" />
    </div>
  )
}

function StreamerHeadline({
  guildId,
  userId,
  channelName
}: {
  guildId: string
  userId: string
  channelName: string
}): React.JSX.Element {
  const { name } = useMemberView(guildId, userId)
  return (
    <>
      {name} is live in {channelName}
    </>
  )
}
