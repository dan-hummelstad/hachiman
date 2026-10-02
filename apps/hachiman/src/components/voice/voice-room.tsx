import { PhoneCall, PhoneOff } from 'lucide-react'
import { Permissions, has, type VoiceState } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { SelfVoiceToggles } from '@/components/voice/self-voice-toggles'
import { VoiceStateBadges } from '@/components/voice/voice-state-badges'
import { useChannelOccupants, usePermissions } from '@/hooks/use-hachiman'
import { useSpeakingMember } from '@/hooks/use-member'
import type { GuildChannel } from '@/lib/model'
import { voiceService } from '@/services/VoiceService'
import { useVoiceStore } from '@/stores/voiceStore'

/** Body of a voice channel: who is in it, plus join / leave / mute / deafen. No messages. */
export function VoiceRoom({ channel }: { channel: GuildChannel }): React.JSX.Element {
  const occupants = useChannelOccupants(channel.guildId, channel.id)
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-6">
      {occupants.length > 0 ? (
        <ul className="flex max-w-3xl flex-wrap justify-center gap-3">
          {occupants.map((vs) => (
            <OccupantTile key={vs.userId} guildId={channel.guildId} state={vs} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">No one is here yet.</p>
      )}
      <VoiceControls channel={channel} />
    </div>
  )
}

function OccupantTile({
  guildId,
  state
}: {
  guildId: string
  state: VoiceState
}): React.JSX.Element {
  const { member, name, ink, speaking } = useSpeakingMember(guildId, state.userId)
  return (
    <li>
      <UserProfilePopover userId={state.userId} guildId={guildId} side="bottom">
        <button
          type="button"
          className="hover:bg-accent/60 focus-visible:outline-ring flex w-36 flex-col items-center gap-2 border px-3 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2"
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
            <VoiceStateBadges state={state} />
          </span>
        </button>
      </UserProfilePopover>
    </li>
  )
}

function VoiceControls({ channel }: { channel: GuildChannel }): React.JSX.Element {
  const here = useVoiceStore((s) => s.channelId === channel.id)
  const canConnect = has(usePermissions(channel.guildId, channel.id), Permissions.CONNECT)

  if (here) {
    return (
      <div className="flex items-center gap-1">
        <SelfVoiceToggles />
        <Button variant="destructive" className="ml-2" onClick={() => voiceService.leaveVoice()}>
          <PhoneOff />
          Leave
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button disabled={!canConnect} onClick={() => void voiceService.join(channel)}>
        <PhoneCall />
        Join voice
      </Button>
      {!canConnect && (
        <p className="text-muted-foreground text-xs">
          You don&apos;t have permission to join {channel.name}.
        </p>
      )}
    </div>
  )
}
