import * as ResizablePrimitive from 'react-resizable-panels'

import { cn } from '@/lib/utils'

// shadcn resizable over react-resizable-panels v4 (Group / Panel / Separator).

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps): React.JSX.Element {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full aria-[orientation=vertical]:flex-col', className)}
      {...props}
    />
  )
}

function ResizablePanel(props: ResizablePrimitive.PanelProps): React.JSX.Element {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

/** A 1px border with a wider invisible hit area. */
function ResizableHandle({
  className,
  ...props
}: ResizablePrimitive.SeparatorProps): React.JSX.Element {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        'bg-border focus-visible:ring-ring data-[separator=active]:bg-primary data-[separator=hover]:bg-primary/60 relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:outline-hidden',
        className
      )}
      {...props}
    />
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
