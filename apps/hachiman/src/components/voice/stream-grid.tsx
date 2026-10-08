import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, LoaderCircle, Maximize, Minimize, Volume2, VolumeX } from 'lucide-react'
import type { VoiceState } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { SystemTag } from '@/components/ui/system-tag'
import { TileNameTag } from '@/components/voice/voice-tile'
import { VolumeRange } from '@/components/voice/volume-range'
import { TILE, stageColumns } from '@/components/voice/voice-tile-styles'
import { useMemberView } from '@/hooks/use-member'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { DEFAULT_USER_AUDIO, usePrefsStore } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * Live screen shares in a voice channel. Only someone in the same voice session receives the
 * video, so other viewers see the LIVE badge and no tiles.
 *
 * `secure` holds the users with a leaf in the MLS tree of the own call (§12.10.1). The video of
 * any other user shows as a placeholder, never as a trusted stream. Null outside the call.
 *
 * As in Discord, a remote share starts unwatched: its tile shows "Watch stream", and the video
 * shows only after that click, until "Stop watching". The own share shows its preview.
 */
export function StreamGrid({
  guildId,
  occupants,
  secure
}: {
  guildId: string | null
  occupants: VoiceState[]
  secure: ReadonlySet<string> | null
}): React.JSX.Element | null {
  const meId = useUserStore((s) => s.me?.id)
  const localScreen = useVoiceStore((s) => s.localScreen)
  const screens = useVoiceStore((s) => s.screens)
  const watching = useVoiceStore((s) => s.watching)
  const [focused, setFocused] = useState<string | null>(null)

  const live = occupants.flatMap((vs) => {
    if (vs.userId === meId) return localScreen ? [{ userId: vs.userId, stream: localScreen }] : []
    const stream = vs.selfStream ? screens.get(vs.userId) : undefined
    if (!stream) return []
    return [{ userId: vs.userId, stream: secure?.has(vs.userId) ? stream : null }]
  })
  if (live.length === 0) return null
  const shown = live.some((l) => l.userId === focused)
    ? live.filter((l) => l.userId === focused)
    : live

  return (
    <div
      className={cn('grid min-h-0 w-full flex-1 auto-rows-fr gap-3', stageColumns(shown.length))}
    >
      {shown.map((l) => (
        <StreamTile
          key={l.userId}
          guildId={guildId}
          userId={l.userId}
          stream={l.stream}
          self={l.userId === meId}
          watched={watching.has(l.userId)}
          focused={l.userId === focused}
          onToggleFocus={() => setFocused((f) => (f === l.userId ? null : l.userId))}
        />
      ))}
    </div>
  )
}

const TILE_BUTTON =
  'bg-surface-window/85 text-text-primary hover:bg-surface-window hover:text-text-primary'

function StreamTile({
  guildId,
  userId,
  stream,
  self,
  watched,
  focused,
  onToggleFocus
}: {
  guildId: string | null
  userId: string
  /** Null: the user has no leaf in the call group yet. */
  stream: MediaStream | null
  self: boolean
  /** A remote share shows its video only while watched. */
  watched: boolean
  focused: boolean
  onToggleFocus: () => void
}): React.JSX.Element {
  const { name, ink, avatar } = useMemberView(guildId, userId)
  const frame = useRef<HTMLDivElement>(null)
  const [fullscreen, toggleFullscreen] = useFullscreen(frame)

  if (!stream)
    return (
      <div
        className={cn(
          TILE,
          'text-text-secondary flex flex-col items-center justify-center gap-2 text-xs'
        )}
      >
        <TileNameTag>
          <SystemTag kind="live" />
          <span className="truncate" style={ink ? { color: ink } : undefined}>
            {name}
          </span>
        </TileNameTag>
        <LoaderCircle className="text-feature-event-text size-5 animate-spin" aria-hidden />
        {name} is joining the encrypted call
      </div>
    )

  if (!self && !watched)
    return (
      <div className={cn(TILE, 'flex flex-col items-center justify-center gap-4')}>
        <TileNameTag>
          <SystemTag kind="live" />
          <span className="truncate" style={ink ? { color: ink } : undefined}>
            {name}
          </span>
        </TileNameTag>
        <UserAvatar name={name} avatar={avatar} color={ink} size={72} />
        <Button variant="voice" onClick={() => voiceService.setWatching(userId, true)}>
          <Eye />
          Watch stream
        </Button>
      </div>
    )

  return (
    <div ref={frame} className={cn(TILE, 'group overflow-hidden bg-black')}>
      <button
        type="button"
        aria-label={focused ? `Show all streams` : `Focus ${name}'s stream`}
        className="focus-visible:outline-line-focus size-full outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
        onClick={onToggleFocus}
      >
        <video
          ref={(el) => {
            // Only on a change: assigning srcObject again restarts the load.
            if (el && el.srcObject !== stream) el.srcObject = stream
          }}
          autoPlay
          playsInline
          muted
          className="size-full object-contain"
        />
      </button>
      <TileNameTag>
        <SystemTag kind="live" />
        <span className="truncate" style={ink && !self ? { color: ink } : undefined}>
          {self ? 'Your stream' : name}
        </span>
      </TileNameTag>
      <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        {!self && <StreamAudioControl userId={userId} />}
        {!self && (
          <IconButton
            label="Stop watching"
            className={TILE_BUTTON}
            onClick={() => voiceService.setWatching(userId, false)}
          >
            <EyeOff />
          </IconButton>
        )}
        <IconButton
          label={fullscreen ? 'Exit full screen' : 'Full screen'}
          className={TILE_BUTTON}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <Minimize /> : <Maximize />}
        </IconButton>
      </div>
    </div>
  )
}

/**
 * The volume (0–200 %) and the local mute of a watched stream's audio. Only this device plays it;
 * the value stays per user for the next streams too.
 */
function StreamAudioControl({ userId }: { userId: string }): React.JSX.Element {
  const audio = usePrefsStore((s) => s.streamAudio[userId] ?? DEFAULT_USER_AUDIO)
  const setStreamAudio = usePrefsStore((s) => s.setStreamAudio)
  return (
    <div className="bg-surface-window/85 flex items-center gap-1 rounded-full pr-2">
      <IconButton
        label={audio.muted ? 'Unmute stream' : 'Mute stream'}
        pressed={audio.muted}
        className={TILE_BUTTON}
        onClick={() => setStreamAudio(userId, { muted: !audio.muted })}
      >
        {audio.muted ? <VolumeX /> : <Volume2 />}
      </IconButton>
      <VolumeRange
        label="Stream volume"
        audio={audio}
        onVolume={(volume) => setStreamAudio(userId, { volume })}
        className="w-24"
      />
    </div>
  )
}

/**
 * Whether `frame` is the fullscreen element, and a toggle that enters or leaves it. The state
 * follows `fullscreenchange`, so Esc and the OS controls keep the button right.
 */
function useFullscreen(frame: React.RefObject<HTMLElement | null>): [boolean, () => void] {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const sync = (): void =>
      setOn(frame.current !== null && document.fullscreenElement === frame.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [frame])
  const toggle = (): void => {
    const el = frame.current
    if (!el) return
    const change =
      document.fullscreenElement === el ? document.exitFullscreen() : el.requestFullscreen()
    change.catch((err: unknown) => console.warn('[voice] full screen change failed', err))
  }
  return [on, toggle]
}
