import { useEffect, useRef, useState } from 'react'
import { Maximize } from 'lucide-react'
import type { VoiceState } from '@hachiman/client'
import { IconButton } from '@/components/ui/icon-button'
import { LiveBadge } from '@/components/voice/voice-state-badges'
import { useMemberView } from '@/hooks/use-member'
import { cn } from '@/lib/utils'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * Live screen shares in a voice channel. Only someone in the same voice session receives the
 * video, so other viewers see the LIVE badge and no tiles.
 */
export function StreamGrid({
  guildId,
  occupants
}: {
  guildId: string
  occupants: VoiceState[]
}): React.JSX.Element | null {
  const meId = useUserStore((s) => s.me?.id)
  const localScreen = useVoiceStore((s) => s.localScreen)
  const screens = useVoiceStore((s) => s.screens)
  const [focused, setFocused] = useState<string | null>(null)

  const live = occupants.flatMap((vs) => {
    const stream = vs.userId === meId ? localScreen : vs.selfStream ? screens.get(vs.userId) : null
    return stream ? [{ userId: vs.userId, stream }] : []
  })
  if (live.length === 0) return null
  const shown = live.some((l) => l.userId === focused)
    ? live.filter((l) => l.userId === focused)
    : live

  return (
    <div
      className={cn(
        'grid min-h-0 w-full flex-1 auto-rows-fr gap-2',
        shown.length > 1 && 'md:grid-cols-2'
      )}
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
  stream: MediaStream
  self: boolean
  focused: boolean
  onToggleFocus: () => void
}): React.JSX.Element {
  const { name } = useMemberView(guildId, userId)
  const frame = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (video.current) video.current.srcObject = stream
  }, [stream])

  return (
    <div ref={frame} className="group relative min-h-0 overflow-hidden border bg-black">
      <button
        type="button"
        aria-label={focused ? `Show all streams` : `Focus ${name}'s stream`}
        className="focus-visible:outline-ring size-full focus-visible:outline-2 focus-visible:-outline-offset-2"
        onClick={onToggleFocus}
      >
        <video ref={video} autoPlay playsInline muted className="size-full object-contain" />
      </button>
      <span className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1.5 bg-black/70 px-1.5 py-0.5 text-xs text-white">
        <LiveBadge />
        {self ? 'Your stream' : name}
      </span>
      <IconButton
        label="Full screen"
        className="absolute top-2 right-2 bg-black/70 text-white opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-black/90 hover:text-white"
        onClick={() => void frame.current?.requestFullscreen()}
      >
        <Maximize />
      </IconButton>
    </div>
  )
}
