import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Maximize2, X } from 'lucide-react'
import { LiveDot } from '@/components/ui/live'
import { secureUserIds } from '@/components/voice/call-roster'
import { cornerPoint, snapCorner, type Corner } from '@/components/voice/popout-snap'
import { useCallParticipants } from '@/components/voice/use-call-security'
import { useMemberView } from '@/hooks/use-member'
import { useLayout } from '@/hooks/use-layout'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { navigate } from '@/stores/navStore'
import { useVoiceStore } from '@/stores/voiceStore'

// The stages (StreamGrid) mounted now. While one shows, the watched share is on screen already.
const stages = new Set<symbol>()
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** StreamGrid calls this: the popout hides while any stage is mounted. */
export function useStageMounted(): void {
  useEffect(() => {
    const key = Symbol('stage')
    stages.add(key)
    emit()
    return () => {
      stages.delete(key)
      emit()
    }
  }, [])
}

/** Where the popout parks. Module state: it keeps its corner for the session, across streams. */
let parked: Corner = 'br'

/**
 * A watched screen share in a small window over the app, once the user leaves the call's stage
 * (Arc-style). Drag it anywhere; on release it sticks to the corner the throw points at. It shows
 * only a share from someone with a leaf in the call's MLS tree, as the stage does.
 */
export function StreamPopout(): React.JSX.Element | null {
  const stageOpen = useSyncExternalStore(subscribe, () => stages.size > 0)
  const guildId = useVoiceStore((s) => s.guildId)
  const channelId = useVoiceStore((s) => s.channelId)
  const watching = useVoiceStore((s) => s.watching)
  const screens = useVoiceStore((s) => s.screens)
  const participants = useCallParticipants(guildId, channelId ?? '')
  const secure = useMemo(() => (participants ? secureUserIds(participants) : null), [participants])
  const userId = [...watching].find((id) => screens.has(id) && secure?.has(id))
  const stream = userId ? screens.get(userId) : undefined
  if (stageOpen || !channelId || !userId || !stream) return null
  return <PopoutWindow guildId={guildId} channelId={channelId} userId={userId} stream={stream} />
}

function PopoutWindow({
  guildId,
  channelId,
  userId,
  stream
}: {
  guildId: string | null
  channelId: string
  userId: string
  stream: MediaStream
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const { name } = useMemberView(guildId, userId)
  const viewport = useViewport()
  const size = mobile ? { w: 208, h: 146 } : { w: 336, h: 221 }
  // Clear of the tab bar and sidebar on desktop, of the status bar and composer on mobile.
  const inset = mobile
    ? { top: 96, right: 12, bottom: 132, left: 12 }
    : { top: 56, right: 16, bottom: 96, left: 296 }
  const [corner, setCorner] = useState<Corner>(parked)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const grab = useRef<{
    dx: number
    dy: number
    t: number
    x: number
    y: number
    vx: number
    vy: number
  } | null>(null)
  const at = drag ?? cornerPoint(corner, size, viewport, inset)

  const backToStage = (): void =>
    navigate(guildId ? { kind: 'channel', guildId, channelId } : { kind: 'dm', channelId })

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    grab.current = {
      dx: e.clientX - at.x,
      dy: e.clientY - at.y,
      t: e.timeStamp,
      x: at.x,
      y: at.y,
      vx: 0,
      vy: 0
    }
    setDrag({ x: at.x, y: at.y })
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const g = grab.current
    if (!g) return
    const x = e.clientX - g.dx
    const y = e.clientY - g.dy
    const dt = Math.max(1, e.timeStamp - g.t)
    // Smoothed velocity (px/ms) of the last moves: the throw.
    g.vx = g.vx * 0.5 + ((x - g.x) / dt) * 0.5
    g.vy = g.vy * 0.5 + ((y - g.y) / dt) * 0.5
    Object.assign(g, { x, y, t: e.timeStamp })
    setDrag({ x, y })
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const g = grab.current
    if (!g) return
    grab.current = null
    // A held pointer that stopped before release is no throw.
    const still = e.timeStamp - g.t > 80
    parked = snapCorner(g.x, g.y, still ? 0 : g.vx, still ? 0 : g.vy, size, viewport)
    setCorner(parked)
    setDrag(null)
  }

  return (
    <div
      role="dialog"
      aria-label={`${name}'s stream`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={backToStage}
      style={{ left: at.x, top: at.y, width: size.w, height: size.h }}
      className={cn(
        'group border-line-strong bg-surface-raised fixed z-40 flex touch-none flex-col overflow-hidden rounded-[12px] border shadow-[var(--shadow-soft)] select-none',
        drag ? 'cursor-grabbing' : 'cursor-grab transition-[left,top] duration-300 ease-out'
      )}
    >
      <div className="relative min-h-0 flex-1 bg-black">
        <video
          ref={(el) => {
            // Only on a change: assigning srcObject again restarts the load.
            if (el && el.srcObject !== stream) el.srcObject = stream
          }}
          autoPlay
          playsInline
          muted
          className="pointer-events-none size-full object-contain"
        />
        <div
          className={cn(
            'absolute inset-x-0 top-0 flex justify-end gap-1 bg-gradient-to-b from-black/60 to-transparent p-1.5 transition-opacity',
            !mobile && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          )}
        >
          <PopoutButton label="Back to the big screen" onClick={backToStage}>
            <Maximize2 />
          </PopoutButton>
          <PopoutButton
            label="Stop watching"
            onClick={() => voiceService.setWatching(userId, false)}
          >
            <X />
          </PopoutButton>
        </div>
      </div>
      <div className="border-line-hairline flex h-[30px] shrink-0 items-center gap-1.5 border-t px-2.5">
        <LiveDot />
        <span className="text-text-secondary min-w-0 truncate text-[12px]">{name}</span>
      </div>
    </div>
  )
}

function PopoutButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-control focus-visible:outline-line-focus flex size-7 items-center justify-center bg-black/50 text-white outline-none hover:bg-black/70 focus-visible:outline-2 [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

function useViewport(): { w: number; h: number } {
  const [v, setV] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const on = (): void => setV({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return v
}
