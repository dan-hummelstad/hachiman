import { Phone, PhoneCall, PhoneOff } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { useCanJoinVoice } from '@/components/voice/use-call-security'
import { Stage } from '@/components/voice/voice-room'
import { useChannelOccupants } from '@/hooks/use-hachiman'
import { useMemberView } from '@/hooks/use-member'
import { callRingService } from '@/services/CallRingService'
import { voiceService } from '@/services/VoiceService'
import { useRingStore } from '@/stores/ringStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * The call of a DM or group DM (§6 "DM calls"), above the transcript as in Discord. In the call:
 * the voice stage (tiles, screen shares, the control bar). Else, while others are in it: a banner
 * with "Join call". Nothing when no call is on.
 */
export function DmCallPanel({ channel }: { channel: Channel }): React.JSX.Element | null {
  const here = useVoiceStore((s) => s.channelId === channel.id)
  const occupants = useChannelOccupants(null, channel.id)
  if (here)
    return (
      <div className="border-line-hairline relative flex h-[min(55vh,520px)] shrink-0 flex-col border-b">
        <Stage channel={channel} />
      </div>
    )
  if (occupants.length === 0) return null
  return <JoinCallBanner channel={channel} userIds={occupants.map((vs) => vs.userId)} />
}

function JoinCallBanner({
  channel,
  userIds
}: {
  channel: Channel
  userIds: string[]
}): React.JSX.Element {
  const canJoin = useCanJoinVoice(null, channel.id)
  const ringing = useRingStore((s) => s.ring?.channelId === channel.id)
  return (
    <div
      role="region"
      aria-label="Call"
      className="border-feature-voice/30 bg-feature-voice/10 flex shrink-0 items-center gap-3 border-b px-4 py-2.5"
    >
      <ul className="flex -space-x-2">
        {userIds.slice(0, 4).map((id) => (
          <li key={id}>
            <CallAvatar userId={id} />
          </li>
        ))}
      </ul>
      <p className="text-text-primary min-w-0 flex-1 truncate text-sm font-semibold">
        {ringing ? 'Incoming call' : `${userIds.length} in the call`}
      </p>
      {ringing && (
        <Button variant="danger-outline" size="sm" onClick={() => callRingService.decline()}>
          <PhoneOff />
          Decline
        </Button>
      )}
      <Button
        variant="voice"
        size="sm"
        disabled={!canJoin}
        onClick={() => void voiceService.join(channel)}
      >
        <PhoneCall />
        Join call
      </Button>
    </div>
  )
}

function CallAvatar({ userId }: { userId: string }): React.JSX.Element {
  const { name, avatar } = useMemberView(null, userId)
  return <UserAvatar name={name} avatar={avatar} size={28} />
}

/** The phone button in the header of a DM: starts the call, or joins the one that is on. */
export function DmCallButton({
  channel,
  className
}: {
  channel: Channel
  className?: string
}): React.JSX.Element {
  const here = useVoiceStore((s) => s.channelId === channel.id)
  const active = useChannelOccupants(null, channel.id).length > 0
  const canJoin = useCanJoinVoice(null, channel.id)
  return (
    <IconButton
      label={here ? 'In the call' : active ? 'Join call' : 'Start call'}
      tooltipSide="bottom"
      disabled={here || !canJoin}
      onClick={() => void voiceService.join(channel)}
      className={className}
    >
      <Phone />
    </IconButton>
  )
}
