import {
  ArrowLeft,
  ArrowRight,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen
} from 'lucide-react'
import { toggleSidebar, useSidebarView } from '@/components/shell/sidebar-state'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Keycap } from '@/components/ui/keycap'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { goBack, goForward } from '@/hooks/use-app-shortcuts'
import { useKeybindLabel } from '@/hooks/use-keybinds'
import { useCanGoBack, useCanGoForward } from '@/stores/navStore'
import { useSidebarSide } from '@/stores/prefsStore'

const CONTROL = 'text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded-control'

/**
 * The sidebar controls (N2, N3): the sidebar toggle, back and forward.
 * In the sidebar's controls row when docked or revealed, at the start of the tab bar when hidden.
 * `toggle` false: back and forward only (a hidden sidebar on the right has its toggle at the
 * end of the tab bar, at the edge it slides in from).
 */
export function SidebarControls({ toggle = true }: { toggle?: boolean }): React.JSX.Element {
  const canBack = useCanGoBack()
  const canForward = useCanGoForward()
  return (
    <div className="flex items-center gap-0.5">
      {toggle && <SidebarToggle />}
      <IconButton
        label="Back"
        tooltipSide="bottom"
        disabled={!canBack}
        onClick={() => goBack()}
        className={CONTROL}
      >
        <ArrowLeft className="size-4" />
      </IconButton>
      <IconButton
        label="Forward"
        tooltipSide="bottom"
        disabled={!canForward}
        onClick={() => goForward()}
        className={CONTROL}
      >
        <ArrowRight className="size-4" />
      </IconButton>
    </div>
  )
}

/** Hides or docks the sidebar; its panel icon faces the sidebar's side. */
export function SidebarToggle(): React.JSX.Element {
  const sidebar = useSidebarView()
  // A revealed sidebar reads "dock": one click pins it back into the window.
  const key = useKeybindLabel('sidebar')
  const label = sidebar === 'docked' ? 'Hide sidebar' : 'Dock sidebar'
  const right = useSidebarSide() === 'right'
  const tucked = sidebar === 'tucked'
  const Icon = right
    ? tucked
      ? PanelRightOpen
      : PanelRightClose
    : tucked
      ? PanelLeftOpen
      : PanelLeftClose
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="quiet"
          aria-label={label}
          onClick={toggleSidebar}
          className={`${CONTROL} size-8 p-0 has-[>svg]:p-0`}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-2">
        {label} {key && <Keycap>{key}</Keycap>}
      </TooltipContent>
    </Tooltip>
  )
}
