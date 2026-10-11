import { LoaderCircle, ShieldCheck } from 'lucide-react'
import { StreamerName } from '@/components/voice/live-card'
import { useCallParticipants, useCallSecurity } from '@/components/voice/use-call-security'
import { useVoiceRegionName } from '@/components/voice/use-voice-region'
import { useChannelOccupants } from '@/hooks/use-hachiman'
import type { GuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { openDialog } from '@/stores/dialogStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * The meta line of a voice channel's header, after the channel name: "Voice · n in call ·
 * <region>", plus "<name> is live" while someone streams. In the own call, n counts the people
 * of the MLS tree and those joining it; outside it, the gateway voice states.
 */
export function VoiceHeaderMeta({ channel }: { channel: GuildChannel }): React.JSX.Element {
  const occupants = useChannelOccupants(channel.guildId, channel.id)
  const participants = useCallParticipants(channel.guildId, channel.id)
  const region = useVoiceRegionName(channel.guildId)
  const count = participants
    ? participants.filter((p) => p.status !== 'leaving').length
    : occupants.length
  const streamer = occupants.find((vs) => vs.selfStream)?.userId ?? null
  return (
    <span className="text-text-tertiary min-w-0 truncate text-[13px] font-medium">
      Voice · {count} in call
      {region && ` · ${region}`}
      {streamer && (
        <>
          {' · '}
          <StreamerName guildId={channel.guildId} userId={streamer} />
        </>
      )}
    </span>
  )
}

/**
 * The header action of a voice channel in the own call: the green "Verify call" chip, which opens
 * the verify call dialog. While the call keys are not ready, it is gold and says so. On mobile
 * the label drops "call" ("Verify", "Securing…", M10), and the screen reader still reads it.
 * Renders nothing outside the own call.
 */
export function VoiceHeaderExtras({
  channel
}: {
  channel: GuildChannel
}): React.JSX.Element | null {
  const here = useVoiceStore((s) => s.channelId === channel.id)
  const { kind } = useCallSecurity()
  if (!here || kind === 'none' || kind === 'resync_failed') return null
  const secure = kind === 'secure'
  return (
    <button
      type="button"
      onClick={() => openDialog({ kind: 'verifyCall' })}
      className={cn(
        'rounded-control focus-visible:outline-line-focus inline-flex h-8 shrink-0 items-center gap-1.5 border px-3 text-[13px] leading-none font-bold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 [&_svg]:size-4 [&_svg]:shrink-0',
        'mobile:h-9 mobile:gap-[5px] mobile:px-2.5 mobile:font-extrabold mobile:[&_svg]:size-[17px]',
        secure
          ? 'border-feature-voice/40 bg-feature-voice/10 text-feature-voice-text hover:bg-feature-voice/20'
          : 'border-feature-event/40 bg-feature-event/10 text-feature-event-text hover:bg-feature-event/20'
      )}
    >
      {secure ? <ShieldCheck aria-hidden /> : <LoaderCircle className="animate-spin" aria-hidden />}
      <span>
        {secure ? 'Verify' : 'Securing'}
        <span className="mobile:sr-only"> call</span>
        {!secure && '…'}
      </span>
    </button>
  )
}
