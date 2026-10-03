import { useMemo } from 'react'
import { LoaderCircle, PhoneCall, PhoneOff } from 'lucide-react'
import { Permissions, has, type VoiceState } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { CallLockButton, CallSecurityBanner } from '@/components/voice/call-security'
import { secureUserIds, type CallParticipant } from '@/components/voice/call-roster'
import { ScreenShareControls } from '@/components/voice/screen-share-controls'
import { SelfVoiceToggles } from '@/components/voice/self-voice-toggles'
import { StreamGrid } from '@/components/voice/stream-grid'
import { useCallParticipants, useCallSecurity } from '@/components/voice/use-call-security'
import { VoiceStateBadges } from '@/components/voice/voice-state-badges'
import { useChannelOccupants, usePermissions } from '@/hooks/use-hachiman'
import { useSpeakingMember } from '@/hooks/use-member'
import type { GuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * Body of a voice channel: live screen shares, who is in it, plus join / leave / mute / deafen /
 * share. No messages.
 *
 * In the own call, the list comes from the MLS tree (§12.10.1): a user that only the servers
 * report shows as joining. Outside the call, only the gateway voice states are known.
 */
export function VoiceRoom({ channel }: { channel: GuildChannel }): React.JSX.Element {
  const occupants = useChannelOccupants(channel.guildId, channel.id)
  const participants = useCallParticipants(channel.guildId, channel.id)
  const secure = useMemo(() => (participants ? secureUserIds(participants) : null), [participants])
  const tiles: { userId: string; state: VoiceState | null; status: TileStatus }[] = participants
    ? participants.map((p) => ({ userId: p.userId, state: p.voiceState, status: p.status }))
    : occupants.map((vs) => ({ userId: vs.userId, state: vs, status: null }))

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-6">
      <StreamGrid guildId={channel.guildId} occupants={occupants} secure={secure} />
      {tiles.length > 0 ? (
        <ul className="flex max-w-3xl flex-wrap justify-center gap-3">
          {tiles.map((t) => (
            <OccupantTile
              key={t.userId}
              guildId={channel.guildId}
              userId={t.userId}
              state={t.state}
              status={t.status}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">No one is here yet.</p>
      )}
      <VoiceControls channel={channel} />
    </div>
  )
}

/** Null outside the own call: no tree state to show. */
type TileStatus = CallParticipant['status'] | null

const STATUS_LABEL: Record<Exclude<TileStatus, 'secure' | null>, string> = {
  joining: 'Joining securely…',
  leaving: 'Leaving'
}

function OccupantTile({
  guildId,
  userId,
  state,
  status
}: {
  guildId: string
  userId: string
  state: VoiceState | null
  status: TileStatus
}): React.JSX.Element {
  const { member, name, ink, speaking } = useSpeakingMember(guildId, userId)
  return (
    <li>
      <UserProfilePopover userId={userId} guildId={guildId} side="bottom">
        <button
          type="button"
          className={cn(
            'hover:bg-accent/60 focus-visible:outline-ring flex w-36 flex-col items-center gap-2 border px-3 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2',
            status !== null && status !== 'secure' && 'opacity-60'
          )}
        >
          <UserAvatar
            name={name}
            avatar={member?.user.avatar}
            color={ink}
            size={64}
            speaking={speaking}
          />
          <span className="flex w-full min-w-0 items-center justify-center gap-1 text-sm">
            <span className="truncate font-medium" style={ink ? { color: ink } : undefined}>
              {name}
            </span>
            {state && <VoiceStateBadges state={state} />}
          </span>
          {status !== null && status !== 'secure' && (
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              {status === 'joining' && <LoaderCircle className="size-3 animate-spin" aria-hidden />}
              {STATUS_LABEL[status]}
            </span>
          )}
        </button>
      </UserProfilePopover>
    </li>
  )
}

function VoiceControls({ channel }: { channel: GuildChannel }): React.JSX.Element {
  const here = useVoiceStore((s) => s.channelId === channel.id)
  const canConnect = has(usePermissions(channel.guildId, channel.id), Permissions.CONNECT)
  const { kind } = useCallSecurity()
  const updateRequired = kind === 'update_required'

  if (here) {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-1">
          <CallLockButton />
          <SelfVoiceToggles />
          <ScreenShareControls />
          <Button variant="destructive" className="ml-2" onClick={() => voiceService.leaveVoice()}>
            <PhoneOff />
            Leave
          </Button>
        </div>
        <CallSecurityBanner />
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        disabled={!canConnect || updateRequired || kind === 'resyncing'}
        onClick={() => void voiceService.join(channel)}
      >
        <PhoneCall />
        Join voice
      </Button>
      <CallSecurityBanner />
      {!canConnect && (
        <p className="text-muted-foreground text-xs">
          You don&apos;t have permission to join {channel.name}.
        </p>
      )}
    </div>
  )
}
