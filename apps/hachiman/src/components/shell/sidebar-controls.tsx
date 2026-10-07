import { ArrowLeft, ArrowRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { toggleSidebar, useSidebarView } from '@/components/shell/sidebar-state'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Keycap } from '@/components/ui/keycap'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { goBack, goForward } from '@/hooks/use-app-shortcuts'
import { MOD_KEY } from '@/lib/mod-key'
import { useCanGoBack, useCanGoForward } from '@/stores/navStore'

const CONTROL = 'text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded-control'

/**
 * The sidebar controls (N2, N3): the sidebar toggle, back and forward.
 * In the sidebar's controls row when docked or revealed, at the start of the tab bar when hidden.
 */
export function SidebarControls(): React.JSX.Element {
  const sidebar = useSidebarView()
  const canBack = useCanGoBack()
  const canForward = useCanGoForward()
  // A revealed sidebar reads "dock": one click pins it back into the window.
  const label = sidebar === 'docked' ? 'Hide sidebar' : 'Dock sidebar'
  const Icon = sidebar === 'tucked' ? PanelLeftOpen : PanelLeftClose
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            aria-label={label}
            onClick={toggleSidebar}
            className={`${CONTROL} size-8 p-0 has-[>svg]:p-0`}
          >
            <Icon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="flex items-center gap-2">
          {label} <Keycap>{MOD_KEY}S</Keycap>
        </TooltipContent>
      </Tooltip>
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
