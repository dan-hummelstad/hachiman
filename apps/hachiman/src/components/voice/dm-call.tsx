import { useEffect, useRef } from 'react'
import { Phone, PhoneCall, PhoneOff } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { closeDmStage, openDmStage, useDmStageShown } from '@/components/voice/dm-stage-state'
import { useCanJoinVoice } from '@/components/voice/use-call-security'
import { Stage } from '@/components/voice/voice-room'
import { useChannelOccupants } from '@/hooks/use-hachiman'
import { useLayout } from '@/hooks/use-layout'
import { useMemberView } from '@/hooks/use-member'
import { channelLabel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { callRingService } from '@/services/CallRingService'
import { voiceService } from '@/services/VoiceService'
import { useRingStore } from '@/stores/ringStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** The header's call button of the mobile DM in my call: "Show the chat" focuses it. */
const callButton: { current: HTMLButtonElement | null } = { current: null }

/** The stage's "Show the chat": back to the chat, with the focus on the header's call button. */
const showChat = (): void => {
  closeDmStage()
  callButton.current?.focus()
}

/**
 * The call of a DM or group DM (§6 "DM calls"), above the transcript as in Discord. In the call:
 * the voice stage (tiles, screen shares, the control bar). Else, while others are in it: a banner
 * with "Join call". Nothing when no call is on.
 *
 * On the mobile layout, my call shows as the voice bar on the composer, and the stage shows only
 * after a tap on the bar or the call button: then it fills the chat card, and its "Show the chat"
 * button goes back.
 */
export function DmCallPanel({ channel }: { channel: Channel }): React.JSX.Element | null {
  const mobile = useLayout() === 'mobile'
  const here = useVoiceStore((s) => s.channelId === channel.id)
  const occupants = useChannelOccupants(null, channel.id)
  const stage = useDmStageShown(channel.id)
  if (here && mobile) return stage ? <MobileDmStage channel={channel} /> : null
  if (here)
    return (
      <div className="border-line-hairline relative flex h-[min(55vh,520px)] shrink-0 flex-col border-b">
        <Stage channel={channel} />
      </div>
    )
  if (occupants.length === 0) return null
  return <JoinCallBanner channel={channel} userIds={occupants.map((vs) => vs.userId)} />
}

/**
 * The full-height stage of a mobile DM call. It takes the focus when it opens, so VoiceOver does
 * not lose its place when the chat goes.
 */
function MobileDmStage({ channel }: { channel: Channel }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const { name } = channelLabel(channel)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-label={`Call in ${name}`}
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      <Stage channel={channel} onShowChat={showChat} />
    </div>
  )
}

/** The banner buttons: 36 touch targets on the mobile layout. */
const BANNER_BUTTON = 'mobile:h-9 mobile:px-3 mobile:text-sm'

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
        <Button
          variant="danger-outline"
          size="sm"
          className={BANNER_BUTTON}
          onClick={() => callRingService.decline()}
        >
          <PhoneOff />
          Decline
        </Button>
      )}
      <Button
        variant="voice"
        size="sm"
        className={BANNER_BUTTON}
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

/**
 * The phone button in the header of a DM: starts the call, or joins the one that is on. In the
 * call it is off on desktop (the stage shows above the chat); on the mobile layout it shows the
 * stage, and the chat again.
 */
export function DmCallButton({
  channel,
  className
}: {
  channel: Channel
  className?: string
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const here = useVoiceStore((s) => s.channelId === channel.id)
  const active = useChannelOccupants(null, channel.id).length > 0
  const canJoin = useCanJoinVoice(null, channel.id)
  const stage = useDmStageShown(channel.id)
  // The label names the action; the lit state is styling only (`data-stage`), not aria-pressed.
  if (here && mobile)
    return (
      <IconButton
        ref={callButton}
        label={stage ? 'Show the chat' : 'Show the call'}
        data-stage={stage ? 'on' : 'off'}
        onClick={() => (stage ? closeDmStage() : openDmStage(channel.id))}
        className={cn(className, 'text-feature-voice-text data-[stage=on]:bg-feature-voice/12')}
      >
        <Phone />
      </IconButton>
    )
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
