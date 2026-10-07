import { useEffect, useRef, useState } from 'react'
import { Eye, LoaderCircle, Maximize } from 'lucide-react'
import type { VoiceState } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { IconButton } from '@/components/ui/icon-button'
import { LiveBadge } from '@/components/voice/voice-state-badges'
import { TileNameTag } from '@/components/voice/voice-tile'
import { TILE, stageColumns } from '@/components/voice/voice-tile-styles'
import { useMemberView } from '@/hooks/use-member'
import { cn } from '@/lib/utils'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * Live screen shares in a voice channel. Only someone in the same voice session receives the
 * video, so other viewers see the LIVE badge and no tiles.
 *
 * `secure` holds the users with a leaf in the MLS tree of the own call (§12.10.1). The video of
 * any other user shows as a placeholder, never as a trusted stream. Null outside the call.
 */
export function StreamGrid({
  guildId,
  occupants,
  secure
}: {
  guildId: string
  occupants: VoiceState[]
  secure: ReadonlySet<string> | null
}): React.JSX.Element | null {
  const meId = useUserStore((s) => s.me?.id)
  const localScreen = useVoiceStore((s) => s.localScreen)
  const screens = useVoiceStore((s) => s.screens)
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
          focused={l.userId === focused}
          onToggleFocus={() => setFocused((f) => (f === l.userId ? null : l.userId))}
        />
      ))}
    </div>
  )
}

function StreamTile({
  guildId,
  userId,
  stream,
  self,
  focused,
  onToggleFocus
}: {
  guildId: string
  userId: string
  /** Null: the user has no leaf in the call group yet. */
  stream: MediaStream | null
  self: boolean
  focused: boolean
  onToggleFocus: () => void
}): React.JSX.Element {
  const { name, ink } = useMemberView(guildId, userId)
  const frame = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (video.current) video.current.srcObject = stream
  }, [stream])

  if (!stream)
    return (
      <div
        className={cn(
          TILE,
          'text-text-secondary flex flex-col items-center justify-center gap-2 text-xs'
        )}
      >
        <TileNameTag>
          <LiveBadge />
          <span className="truncate" style={ink ? { color: ink } : undefined}>
            {name}
          </span>
        </TileNameTag>
        <LoaderCircle className="text-feature-event-text size-5 animate-spin" aria-hidden />
        {name} is joining the encrypted call
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
        <video ref={video} autoPlay playsInline muted className="size-full object-contain" />
      </button>
      <TileNameTag>
        <LiveBadge />
        <span className="truncate" style={ink && !self ? { color: ink } : undefined}>
          {self ? 'Your stream' : name}
        </span>
      </TileNameTag>
      <IconButton
        label="Full screen"
        className="bg-surface-window/85 text-text-primary hover:bg-surface-window hover:text-text-primary absolute top-3 right-3 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        onClick={() => void frame.current?.requestFullscreen()}
      >
        <Maximize />
      </IconButton>
    </div>
  )
}

/**
 * A live stream seen from outside its call (arc plan decision 4). Only members of the call hold
 * the SFrame keys (§12.10), so there is no frame to show: the card shows the streamer's avatar on
 * the live tint with "LIVE · n watching".
 */
export function LiveCard({
  guildId,
  userId,
  channelName,
  watching
}: {
  guildId: string
  userId: string
  channelName: string
  /** The other people in the channel. */
  watching: number
}): React.JSX.Element {
  const { member, name, ink } = useMemberView(guildId, userId)
  return (
    <div className="bg-feature-danger/10 border-feature-danger/30 relative flex aspect-video w-full max-w-2xl items-center justify-center border">
      <span className="absolute top-3 left-3 flex items-center gap-1.5">
        <LiveBadge />
        <span className="bg-surface-window/85 text-text-primary flex h-[18px] items-center gap-1 px-1.5 text-[11px] leading-none font-bold">
          <Eye className="size-3" aria-hidden />
          {watching} watching
        </span>
      </span>
      <UserAvatar
        name={name}
        avatar={member?.user.avatar}
        color={ink}
        size={112}
        className="ring-feature-danger/40 rounded-full ring-4"
      />
      <span className="absolute bottom-3 left-3 flex min-w-0 items-center gap-2">
        <UserAvatar name={name} avatar={member?.user.avatar} color={ink} size={32} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-bold" style={ink ? { color: ink } : undefined}>
            {name}
          </span>
          <span className="text-text-secondary truncate text-xs">Streaming {channelName}</span>
        </span>
      </span>
    </div>
  )
}
