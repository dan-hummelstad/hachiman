import { cn } from '@/lib/utils'
import { usePlatform } from '@/shared/PlatformContext'
import { useSidebarSide } from '@/stores/prefsStore'

/**
 * The window drag region of a frameless host (Electron on macOS, decision 9). Buttons, links and
 * inputs inside stay clickable.
 */
export const DRAG_REGION =
  '[-webkit-app-region:drag] [&_a,&_button,&_input]:[-webkit-app-region:no-drag]'

export interface SidebarProps {
  /**
   * Controls row (36px, right of the macOS traffic lights): sidebar toggle (N3), back and
   * forward (N2), then inbox (N8) and my avatar on the right.
   */
  controls?: React.ReactNode
  /** Top block under the controls: search (N5), then the recent DM and guild rows (N6). */
  top?: React.ReactNode
  /** The navigation: guild channels, the DM space, or a settings section list. Scrolls. */
  middle: React.ReactNode
  /** Foot: the voice dock. */
  foot?: React.ReactNode
  /** The last row, under the foot: the user bar. */
  user?: React.ReactNode
  /** Replaces the size and padding: the mobile drawer is full width inside the safe areas. */
  className?: string
}

/**
 * The sidebar (280): the panel surface with the accent wash at its foot. It holds everything that
 * is not content. Five slots, top to bottom: controls, top, middle, foot, user.
 */
export function Sidebar({
  controls,
  top,
  middle,
  foot,
  user,
  className
}: SidebarProps): React.JSX.Element {
  const { insetTitleBar } = usePlatform()
  const left = useSidebarSide() === 'left'
  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        'text-text-primary bg-surface-panel sidebar-wash border-line-hairline flex h-full min-h-0 w-[280px] shrink-0 flex-col',
        left ? 'border-r' : 'border-l',
        className
      )}
    >
      {/* With an inset title bar and the sidebar on the left, the traffic lights sit at the left
          of this row (trafficLightPosition x 16, y 18), and the controls start after them. */}
      <div
        className={cn(
          'flex h-11 shrink-0 items-center gap-2 px-3',
          insetTitleBar && left && 'pl-[72px]',
          DRAG_REGION
        )}
      >
        {controls}
      </div>
      {top && <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">{top}</div>}
      <div className="flex min-h-0 flex-1 flex-col">{middle}</div>
      {foot && <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">{foot}</div>}
      {user}
    </aside>
  )
}
