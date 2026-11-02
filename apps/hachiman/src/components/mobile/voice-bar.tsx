import { AudioLines, PhoneOff } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { CallTimer, PHASE_TONE, useCallMeta } from '@/components/voice-connected-panel'
import { openDmStage } from '@/components/voice/dm-stage-state'
import { SelfVoiceToggles } from '@/components/voice/self-voice-toggles'
import { channelLabel } from '@/lib/model'
import { openChannelView } from '@/lib/navigation'
import { PHASE, phaseOf } from '@/lib/voice-phase'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { usePlatform } from '@/shared/PlatformContext'
import { useChannelStore } from '@/stores/channelStore'
import { useSelectedChannelId } from '@/stores/navStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** Mute and Deafen: 34 round, a live outline, icon 15. */
const TOGGLE = cn(
  'rounded-pill border-live-line text-live-text hover:text-live-text size-[34px] border',
  "[&_svg:not([class*='size-'])]:size-[15px]",
  'aria-pressed:bg-live-tint aria-pressed:text-live-text'
)

/** Above the tap target that fills the bar: positioned, so it paints over the target's fill. */
const LAYER = 'pointer-events-none relative'

/**
 * Mobile / Voice Bar (kit JLmHX, rule 04 "Voice stays in reach"): 56 high on the composer while
 * I am in a call, on the live tint. The signal disc (ringed while I speak), "In <channel>" and
 * "<guild> · n in call · ping", my call timer, then Mute, Deafen and Leave. A tap anywhere else
 * opens the call: the voice channel's stage or the DM's call stage. It hides while the keyboard
 * is open, and in the DM that shows my call (its strip is already there). The full dock with
 * share screen and the call details stays in the left drawer.
 */
export function VoiceBar(): React.JSX.Element | null {
  const platform = usePlatform()
  const channelId = useVoiceStore((s) => s.channelId)
  const state = useVoiceStore((s) => s.connectionState)
  const channel = useChannelStore((s) => (channelId ? s.channels.get(channelId) : undefined))
  const shownChannelId = useSelectedChannelId()
  const { guildName, count, pingText } = useCallMeta()
  const myId = useUserStore((s) => s.me?.id)
  const speaking = useVoiceStore((s) => myId !== undefined && s.speaking.has(myId))
  if (!channelId) return null
  if (channel?.guildId === null && shownChannelId === channelId) return null

  const phase = phaseOf(state)
  const name = (channel && channelLabel(channel).name) || 'Voice'
  const where = guildName ? `${name} · ${guildName}` : name
  const title =
    phase === 'connected' ? `In ${name}` : phase === 'lost' ? 'Connection lost' : 'Connecting…'
  const meta = [guildName, `${count} in call`, pingText].filter(Boolean).join(' · ')

  return (
    <section
      aria-label="Voice"
      className="bg-live-tint border-live-line relative flex h-14 shrink-0 items-center gap-[11px] border-y px-3.5 in-data-[keyboard=open]:hidden"
    >
      <button
        type="button"
        aria-label={`${PHASE[phase].label}, ${where}. Open the call`}
        disabled={!channel}
        onClick={() => {
          if (!channel) return
          if (channel.guildId === null) openDmStage(channel.id)
          openChannelView(channel)
        }}
        className="active:bg-live/10 focus-visible:outline-line-focus absolute inset-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
      />
      <span
        aria-hidden
        className={cn(
          LAYER,
          'bg-live text-on-live rounded-pill flex size-[30px] shrink-0 items-center justify-center transition-colors',
          speaking && 'ring-live-line ring-2 ring-offset-0'
        )}
      >
        <AudioLines className="size-[15px]" />
      </span>
      <span aria-hidden className={cn(LAYER, 'flex min-w-0 flex-1 flex-col gap-0.5')}>
        <span className={cn('truncate text-[13.5px] leading-4 font-semibold', PHASE_TONE[phase])}>
          {title}
        </span>
        <span className="text-text-tertiary truncate font-mono text-[8px] tracking-[0.9px] uppercase">
          {meta}
        </span>
      </span>
      <CallTimer channelId={channelId} className={cn(LAYER, 'text-[11px]')} />
      <div className="relative flex shrink-0 items-center gap-1.5">
        <span className="contents" onClickCapture={() => platform.haptic('light')}>
          <SelfVoiceToggles className={TOGGLE} />
        </span>
        <IconButton
          label="Leave call"
          onClick={() => voiceService.leaveVoice()}
          className="rounded-pill bg-you text-on-you hover:bg-you/90 hover:text-on-you mobile:active:bg-you/90 size-[34px] [&_svg:not([class*='size-'])]:size-[15px]"
        >
          <PhoneOff />
        </IconButton>
      </div>
    </section>
  )
}
