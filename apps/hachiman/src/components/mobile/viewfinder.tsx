import { QrCode } from 'lucide-react'
import { cn } from '@/lib/utils'

/** idle: tap to scan. live: a camera view shows. error: the last scan failed. */
export type ViewfinderState = 'idle' | 'live' | 'error'

const STATUS: Record<ViewfinderState, { text: string; label: string; dot: string | null }> = {
  idle: { text: 'Tap to scan', label: 'Scan the code with the camera', dot: null },
  live: { text: 'Looking for a code', label: 'Stop the camera', dot: 'bg-feature-voice' },
  error: { text: 'Scan again', label: 'Scan the code again', dot: 'bg-feature-danger' }
}

/**
 * A camera surface: dark in both themes, as the QR tile is white in both themes. The colours are
 * the drawn ones of M22.
 */
const CAMERA =
  'bg-[radial-gradient(130%_130%_at_50%_62%,#2a2b40_0%,#15151f_55%,#08080c_100%)] text-white'

/** The aim: four round corner marks around a 140 square (M22). */
function Aim(): React.JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 164 164"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      className="pointer-events-none absolute top-[90px] left-1/2 size-[164px] -translate-x-1/2"
    >
      <path d="M2 22V10a8 8 0 0 1 8-8h12" />
      <path d="M142 2h12a8 8 0 0 1 8 8v12" />
      <path d="M162 142v12a8 8 0 0 1-8 8h-12" />
      <path d="M22 162H10a8 8 0 0 1-8-8v-12" />
    </svg>
  )
}

/**
 * The 264 camera tile of a QR scan (M22). The native scanner of iOS is a full screen of its own, so
 * a live view inside a sheet is not possible (docs/ios-mobile-ui-spec.md section 5): the tile is
 * the button that opens it. Where the page itself scans (BarcodeDetector), put the camera view in
 * `children` while `state` is 'live'; a tap then stops it. The status pill at the top says the
 * state, so the whole tile has one name for VoiceOver.
 */
export function Viewfinder({
  state = 'idle',
  onActivate,
  disabled,
  children,
  className
}: {
  state?: ViewfinderState
  onActivate: () => void
  disabled?: boolean
  /** The live camera view: it fills the tile. */
  children?: React.ReactNode
  className?: string
}): React.JSX.Element {
  const status = STATUS[state]
  return (
    <button
      type="button"
      data-slot="viewfinder"
      data-state={state}
      aria-label={status.label}
      disabled={disabled}
      onClick={onActivate}
      className={cn(
        'relative h-[264px] w-full shrink-0 overflow-hidden outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-focus disabled:opacity-55 mobile:[-webkit-touch-callout:none]',
        CAMERA,
        className
      )}
    >
      {children ? (
        <span className="absolute inset-0 flex [&_video]:size-full [&_video]:max-w-none [&_video]:object-cover">
          {children}
        </span>
      ) : (
        <span
          aria-hidden
          className="absolute top-[102px] left-1/2 flex size-[140px] -translate-x-1/2 items-center justify-center"
        >
          <QrCode strokeWidth={1.5} className="size-16 text-white/30" />
          <span className="via-accent-text absolute inset-x-1.5 top-[73px] h-0.5 bg-linear-to-r from-transparent to-transparent shadow-[0_0_10px_var(--accent-primary)]" />
        </span>
      )}
      <Aim />
      <span className="pointer-events-none absolute inset-x-0 top-[7px] flex justify-center">
        <span className="rounded-pill flex h-7 items-center gap-[7px] border border-white/10 bg-[#0e0f15]/85 px-3 text-[12.5px] leading-4 font-bold">
          {status.dot && <span aria-hidden className={cn('size-[7px] rounded-full', status.dot)} />}
          {status.text}
        </span>
      </span>
    </button>
  )
}
