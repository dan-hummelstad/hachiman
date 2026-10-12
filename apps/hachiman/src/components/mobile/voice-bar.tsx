import { AudioLines, PhoneOff } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { CallTimer } from '@/components/voice-connected-panel'
import { openDmStage } from '@/components/voice/dm-stage-state'
import { SelfVoiceToggles } from '@/components/voice/self-voice-toggles'
import { channelLabel } from '@/lib/model'
import { openChannelView } from '@/lib/navigation'
import { PHASE, phaseOf } from '@/lib/voice-phase'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { usePlatform } from '@/shared/PlatformContext'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** Mute and Deafen: 36, radius 8, the control fill, icon 17; red while on. */
const TOGGLE = cn(
  'rounded-control bg-fill-control text-text-primary size-9',
  "[&_svg:not([class*='size-'])]:size-[17px]",
  'aria-pressed:bg-feature-danger/15 aria-pressed:text-feature-danger-text'
)

/** Above the tap target that fills the bar: positioned, so it paints over the target's fill. */
const LAYER = 'pointer-events-none relative'

/**
 * Mobile / Voice Bar (kit Q0wWD, rule 04 "Voice stays in reach"): 52 high on the composer while
 * I am in a call. The signal tile (lit while I speak), "Voice connected" and where, my call timer,
 * then Mute, Deafen and Leave. A tap anywhere else opens the call: the voice channel's stage or
 * the DM's call stage. It hides while the keyboard is open. The full dock with share screen and
 * the call details stays in the left drawer.
 */
export function VoiceBar(): React.JSX.Element | null {
  const platform = usePlatform()
  const channelId = useVoiceStore((s) => s.channelId)
  const guildId = useVoiceStore((s) => s.guildId)
  const state = useVoiceStore((s) => s.connectionState)
  const channel = useChannelStore((s) => (channelId ? s.channels.get(channelId) : undefined))
  const guildName = useGuildStore((s) => (guildId ? (s.guilds.get(guildId)?.name ?? null) : null))
  const myId = useUserStore((s) => s.me?.id)
  const speaking = useVoiceStore((s) => myId !== undefined && s.speaking.has(myId))
  if (!channelId) return null

  const phase = phaseOf(state)
  const name = (channel && channelLabel(channel).name) || 'Voice'
  const where = guildName ? `${name} · ${guildName}` : name

  return (
    <section
      aria-label="Voice"
      className="bg-surface-window border-feature-voice/28 relative flex h-[52px] shrink-0 items-center gap-2.5 border-y pr-2.5 pl-3 in-data-[keyboard=open]:hidden"
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
        className="bg-feature-voice/10 active:bg-feature-voice/15 focus-visible:outline-line-focus absolute inset-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
      />
      <span
        aria-hidden
        className={cn(
          LAYER,
          'bg-feature-voice/15 text-feature-voice-text flex size-[30px] shrink-0 items-center justify-center transition-colors',
          speaking && 'bg-feature-voice/30 ring-feature-voice ring-1 ring-inset'
        )}
      >
        <AudioLines className="size-4" />
      </span>
      <span aria-hidden className={cn(LAYER, 'flex min-w-0 flex-1 flex-col gap-px')}>
        <span
          className={cn('truncate text-[13.5px] leading-4 font-extrabold', PHASE[phase].className)}
        >
          {PHASE[phase].label}
        </span>
        <span className="text-text-tertiary truncate text-xs leading-[15px] font-medium">
          {where}
        </span>
      </span>
      <CallTimer
        channelId={channelId}
        className={cn(
          LAYER,
          'bg-feature-voice/12 flex h-5 items-center py-0 font-sans text-[11px] font-bold'
        )}
      />
      <div className="relative flex shrink-0 items-center gap-1.5">
        <span className="contents" onClickCapture={() => platform.haptic('light')}>
          <SelfVoiceToggles className={TOGGLE} />
        </span>
        <IconButton
          label="Leave call"
          onClick={() => voiceService.leaveVoice()}
          className="rounded-control bg-feature-danger/20 text-feature-danger-text mobile:active:bg-feature-danger/30 size-9 min-w-[42px] [&_svg:not([class*='size-'])]:size-[17px]"
        >
          <PhoneOff />
        </IconButton>
      </div>
    </section>
  )
}
