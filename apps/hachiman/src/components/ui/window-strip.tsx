import { usePlatform } from '@/shared/PlatformContext'
import { cn } from '@/lib/utils'

/**
 * 28px draggable top strip for hosts that hide the native title bar (spec §4): today the Electron
 * host on macOS (`IPlatformService.insetTitleBar`). Elsewhere it renders nothing. The traffic
 * lights sit in the 80px left padding
 * (`titleBarStyle: 'hiddenInset'`, `trafficLightPosition: {x: 12, y: 8}`).
 * Buttons/links/inputs inside are automatically `no-drag`.
 */
function WindowStrip({
  title = 'Hachiman',
  className
}: {
  title?: string
  className?: string
}): React.JSX.Element | null {
  const { insetTitleBar } = usePlatform()
  if (!insetTitleBar) return null
  return (
    <div
      data-slot="window-strip"
      className={cn(
        'bg-rail text-muted-foreground flex h-7 shrink-0 items-center justify-center border-b px-20 text-xs leading-4 select-none [-webkit-app-region:drag] [&_a,&_button,&_input]:[-webkit-app-region:no-drag]',
        className
      )}
    >
      <span className="truncate">{title}</span>
    </div>
  )
}

export { WindowStrip }
