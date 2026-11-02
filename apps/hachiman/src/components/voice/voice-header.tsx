import { LoaderCircle, ShieldCheck } from 'lucide-react'
import { LivePill } from '@/components/ui/live'
import { CallTimer } from '@/components/voice-connected-panel'
import { StreamerName } from '@/components/voice/live-card'
import { useCallParticipants, useCallSecurity } from '@/components/voice/use-call-security'
import { useVoiceRegionName } from '@/components/voice/use-voice-region'
import { useChannelOccupants } from '@/hooks/use-hachiman'
import type { GuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { openDialog } from '@/stores/dialogStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** The live pill and my call timer: "LIVE 12:04". */
export function CallClock({ channelId }: { channelId: string }): React.JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <LivePill>LIVE</LivePill>
      <CallTimer channelId={channelId} />
    </span>
  )
}

/**
 * The meta line of a voice channel's header, after the channel name: "Voice · n in call ·
 * <region>", plus "<name> is live" while someone streams. In the own call, n counts the people
 * of the MLS tree and those joining it; outside it, the gateway voice states. Line 2 of the
 * mobile header drops "Voice ·" (M10: "4 in call · Europe (West)"): the icon says it.
 */
export function VoiceHeaderMeta({ channel }: { channel: GuildChannel }): React.JSX.Element {
  const occupants = useChannelOccupants(channel.guildId, channel.id)
  const participants = useCallParticipants(channel.guildId, channel.id)
  const region = useVoiceRegionName(channel.guildId)
  const count = participants
    ? participants.filter((p) => p.status !== 'leaving').length
    : occupants.length
  const streamer = occupants.find((vs) => vs.selfStream)?.userId ?? null
  const inCall = useVoiceStore((s) => s.channelId === channel.id)
  return (
    <>
      {inCall && (
        <>
          <span className="mobile:hidden flex">
            <CallClock channelId={channel.id} />
          </span>
          <span aria-hidden className="bg-line-hairline mobile:hidden h-4 w-px shrink-0" />
        </>
      )}
      <span className="text-text-tertiary mobile:font-mono mobile:text-[8px] mobile:tracking-[0.9px] mobile:uppercase mobile:text-text-disabled min-w-0 truncate text-[12.5px]">
        <span className="mobile:hidden">Voice · </span>
        {count} in call
        {region && ` · ${region}`}
        {streamer && (
          <>
            {' · '}
            <StreamerName guildId={channel.guildId} userId={streamer} />
          </>
        )}
      </span>
    </>
  )
}

/**
 * The header action of a voice channel in the own call: the neutral "Verify call" chip, which opens
 * the verify call dialog. While the call keys are not ready, it is quieter and says so. On mobile
 * the label drops "call" ("Verify", "Securing…", M10), and the screen reader still reads it; the
 * chip is a 36 raised square with no border. Renders nothing outside the own call.
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
        'rounded-control focus-visible:outline-line-focus border-line-strong text-text-secondary hover:bg-surface-hover hover:text-text-primary inline-flex h-8 shrink-0 items-center gap-1.5 border px-3 text-[13px] leading-none font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 [&_svg]:size-4 [&_svg]:shrink-0',
        'mobile:h-9 mobile:gap-[5px] mobile:px-2.5 mobile:[&_svg]:size-[17px]',
        'mobile:border-transparent mobile:bg-surface-raised mobile:active:bg-surface-hover',
        !secure && 'text-text-tertiary'
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
