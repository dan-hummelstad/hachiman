import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'

import { FEATURE_TILE, type Feature } from '@/components/ui/feature'
import { cn } from '@/lib/utils'

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 bg-surface-scrim fixed inset-0 z-50 duration-100',
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // Arc dialog (docs/ui-redesign.md §5): square card, header 16/22, body 18/22, footer
          // 14/22. DialogHeader and DialogFooter bleed to the edges with negative margins.
          'bg-surface-content text-text-primary border-line-hairline data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden border px-[22px] pt-[18px] pb-[18px] shadow-soft duration-100 outline-none has-[[data-slot=dialog-header]]:pt-0 sm:max-w-[500px]',
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-line-focus rounded-control absolute top-4 right-4 z-10 flex size-8 items-center justify-center outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

/**
 * Title (and optional DialogDescription as the subtitle) beside an optional icon tile in a
 * feature colour.
 */
function DialogHeader({
  className,
  icon,
  feature = 'accent',
  children,
  ...props
}: React.ComponentProps<'div'> & { icon?: React.ReactNode; feature?: Feature }) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('-mx-[22px] flex items-center gap-3 px-[22px] pt-4 pr-14 text-left', className)}
      {...props}
    >
      {icon && (
        <span
          aria-hidden
          className={cn(
            'rounded-control flex size-9 shrink-0 items-center justify-center [&_svg]:size-[18px]',
            FEATURE_TILE[feature]
          )}
        >
          {icon}
        </span>
      )}
      <div className="grid min-w-0 flex-1 gap-0.5">{children}</div>
    </div>
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'border-line-hairline -mx-[22px] -mb-[18px] flex flex-col-reverse gap-2 border-t px-[22px] py-3.5 sm:flex-row sm:justify-end',
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        'flex min-h-6 items-center gap-2 text-[18px] leading-6 font-extrabold [&_svg]:size-4 [&_svg]:shrink-0',
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-text-secondary in-data-[slot=dialog-header]:text-text-tertiary in-data-[slot=dialog-header]:text-meta text-sm',
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger
}
