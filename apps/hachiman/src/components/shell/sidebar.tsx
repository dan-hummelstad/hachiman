import { cn } from '@/lib/utils'
import { usePlatform } from '@/shared/PlatformContext'

/**
 * The window drag region of a frameless host (Electron on macOS, decision 9). Buttons, links and
 * inputs inside stay clickable.
 */
export const DRAG_REGION =
  '[-webkit-app-region:drag] [&_a,&_button,&_input]:[-webkit-app-region:no-drag]'

export interface SidebarProps {
  /**
   * Controls row (40px, right of the macOS traffic lights): sidebar toggle (N3), back and
   * forward (N2), inbox (N8). Empty until those features land; the row keeps its height.
   */
  controls?: React.ReactNode
  /** Top block under the controls: search (N5), favourite DMs (N6). */
  top?: React.ReactNode
  /** The navigation: guild channels, the DM space, or a settings section list. Scrolls. */
  middle: React.ReactNode
  /** Foot: the voice dock and the space bar. */
  foot?: React.ReactNode
}

/**
 * The Arc sidebar (280, padding 10): it sits on the window wallpaper and holds everything that
 * is not content. Four slots, top to bottom: controls, top, middle, foot.
 */
export function Sidebar({ controls, top, middle, foot }: SidebarProps): React.JSX.Element {
  const { insetTitleBar } = usePlatform()
  return (
    <aside
      aria-label="Sidebar"
      className="text-text-primary flex h-full min-h-0 w-[280px] shrink-0 flex-col gap-2 px-2.5 pt-1.5 pb-2"
    >
      {/* With an inset title bar the traffic lights sit at the left of this row
          (trafficLightPosition x 16, y 18), and the controls start after them. */}
      <div
        className={cn(
          'flex h-10 shrink-0 items-center gap-1',
          insetTitleBar && 'pl-[72px]',
          DRAG_REGION
        )}
      >
        {controls}
      </div>
      {top && <div className="flex shrink-0 flex-col gap-2">{top}</div>}
      <div className="flex min-h-0 flex-1 flex-col">{middle}</div>
      {foot && <div className="flex shrink-0 flex-col gap-2">{foot}</div>}
    </aside>
  )
}
