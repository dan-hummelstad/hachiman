import { useEffect, useState } from 'react'
import { AudioLines } from 'lucide-react'
import { Permissions, has, type GuildSound } from '@hachiman/client'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePermissions } from '@/hooks/use-hachiman'
import { cn, errMsg } from '@/lib/utils'
import { soundboardService } from '@/services/soundboard'
import { useGuildSounds } from '@/stores/soundsStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { useServerVoice } from '@/components/voice/use-server-voice'

/**
 * The soundboard of the call (§4 Soundboard): a grid of the guild sounds. A click mixes the sound
 * into my sent track and plays it here too. Hidden without SPEAK and USE_SOUNDBOARD in the
 * channel. While I am muted (self or server) the grid is off: nobody would hear it.
 */
export function SoundboardButton({ className }: { className?: string }): React.JSX.Element | null {
  const guildId = useVoiceStore((s) => s.guildId)
  const channelId = useVoiceStore((s) => s.channelId)
  const perms = usePermissions(guildId, channelId)
  const allowed = has(perms, Permissions.SPEAK | Permissions.USE_SOUNDBOARD)
  const selfMute = useVoiceStore((s) => s.selfMute)
  const micActive = useVoiceStore((s) => s.micActive)
  const server = useServerVoice()
  const serverMuted = server.mute || server.deaf
  const sounds = useGuildSounds(guildId)
  useEffect(() => {
    if (guildId && allowed) soundboardService.ensureLoaded(guildId)
  }, [guildId, allowed])
  if (!guildId || !allowed) return null
  const off = selfMute || serverMuted || !micActive
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label={selfMute ? 'Soundboard (unmute to play)' : 'Soundboard'} className={className}>
          <AudioLines />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-80 space-y-2">
        <p className="section-label">Soundboard</p>
        {off && (
          <p className="text-text-tertiary text-xs">
            {serverMuted
              ? 'A moderator muted you.'
              : selfMute
                ? 'Unmute to play sounds.'
                : 'Your microphone is not on.'}
          </p>
        )}
        {sounds.length === 0 ? (
          <p className="text-text-tertiary py-4 text-center text-sm">This guild has no sounds yet.</p>
        ) : (
          <ul className="grid max-h-72 grid-cols-3 gap-1.5 overflow-y-auto">
            {sounds.map((s) => (
              <li key={s.id}>
                <SoundTile sound={s} disabled={off} />
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

function SoundTile({ sound, disabled }: { sound: GuildSound; disabled: boolean }): React.JSX.Element {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const play = (): void => {
    setState({ busy: true, error: null })
    soundboardService
      .play(sound)
      .then(() => setState({ busy: false, error: null }))
      .catch((e: unknown) => setState({ busy: false, error: errMsg(e) }))
  }
  return (
    <button
      type="button"
      disabled={disabled || state.busy}
      title={state.error ?? sound.name}
      onClick={play}
      className={cn(
        'rounded-control bg-surface-hover hover:bg-accent-tint flex h-14 w-full flex-col items-center justify-center gap-0.5 px-1 text-xs disabled:opacity-50',
        state.error && 'text-feature-danger-text'
      )}
    >
      <span aria-hidden className="text-base leading-5">
        {sound.emoji ?? '🔊'}
      </span>
      <span className="w-full truncate text-center">{sound.name}</span>
    </button>
  )
}
