import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'

import { SheetContent, SheetHeader } from '@/components/mobile/sheet'
import { FEATURE_TILE, type Feature } from '@/components/ui/feature'
import { useLayout } from '@/hooks/use-layout'
import { sheetHeaderText } from '@/lib/sheet-header-text'
import { cn } from '@/lib/utils'

/**
 * How a dialog shows on the mobile layout (docs/ios-mobile-ui-spec.md §2.5). `sheet` (the default)
 * rises from the bottom, `dialog` stays a centred card (confirmations, M50, M51, M58), and
 * `fullscreen` fills the screen inside the safe areas (the image lightbox). The desktop layout
 * ignores it.
 */
export type DialogPresentation = 'sheet' | 'dialog' | 'fullscreen'

/** The form that the enclosing `DialogContent` took: the header and footer follow it. */
interface DialogForm {
  form: 'desktop' | DialogPresentation
  /** The content shows a close button. In a sheet the Sheet Header holds it. */
  close: boolean
}

const DialogFormContext = React.createContext<DialogForm>({ form: 'desktop', close: true })

/**
 * Footer buttons on touch: 48 tall, the kit's labels (15/700, primary and danger 15/800, icon 18),
 * the kit's Secondary fill and the Quiet grey. The `>` keeps the rule off nested buttons.
 */
const TOUCH_BUTTONS = cn(
  '[&>[data-slot=button]]:h-12 [&>[data-slot=button]]:px-4 [&>[data-slot=button]]:text-[15px] [&>[data-slot=button]]:font-bold',
  "[&>[data-slot=button]_svg:not([class*='size-'])]:size-[18px]",
  '[&>[data-variant=primary]]:font-extrabold [&>[data-variant=danger]]:font-extrabold',
  '[&>[data-variant=secondary]]:border-line-strong [&>[data-variant=secondary]]:bg-(--fill-control)',
  '[&>[data-variant=quiet]]:text-text-secondary'
)

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

type DialogContentProps = React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  /** The form on the mobile layout (default `sheet`). No effect on the desktop layout. */
  presentation?: DialogPresentation
  /** False: the mobile sheet cannot be dragged, escaped or tapped away (`SheetContent`). */
  dismissible?: boolean
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  presentation = 'sheet',
  dismissible,
  ...props
}: DialogContentProps) {
  const mobile = useLayout() === 'mobile'
  const form: DialogForm['form'] = mobile ? presentation : 'desktop'
  const value = React.useMemo(() => ({ form, close: showCloseButton }), [form, showCloseButton])

  if (form === 'sheet') {
    return (
      <SheetContent
        data-slot="dialog-content"
        className={className}
        dismissible={dismissible}
        {...props}
      >
        <DialogFormContext.Provider value={value}>
          {/* The whole body scrolls; the header sticks to its top and the footer to its foot.
              The scroll padding keeps a field that gets the focus clear of both. */}
          <div
            data-slot="dialog-sheet-body"
            className="mx-[calc(var(--sheet-gutter)*-1)] flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-contain bg-inherit px-(--sheet-gutter) has-[[data-slot=dialog-footer]]:scroll-pb-[72px] has-[[data-slot=dialog-header]]:scroll-pt-[76px] has-[[data-slot=sheet-header]]:scroll-pt-[76px]"
          >
            {children}
          </div>
        </DialogFormContext.Provider>
      </SheetContent>
    )
  }

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // Arc dialog (docs/ui-redesign.md §5): square card, header 16/22, body 18/22, footer
          // 14/22. DialogHeader and DialogFooter bleed to the edges with negative margins.
          'bg-surface-content text-text-primary border-line-hairline data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden border px-[22px] pt-[18px] pb-[18px] shadow-soft duration-100 outline-none has-[[data-slot=dialog-header]]:pt-0 sm:max-w-[500px]',
          // The mobile card's 16 sides (M50, M51), before the caller's classes so `p-0` still wins.
          form === 'dialog' && 'px-4',
          className,
          // Centred on the part of the screen above the keyboard, and never taller than it.
          form === 'dialog' &&
            'top-[calc(var(--app-height,100dvh)/2)] max-h-[calc(var(--app-height,100dvh)-var(--safe-top,0px)-16px)] overflow-y-auto overscroll-contain',
          // After the caller's classes, as a sheet's: a desktop width cannot shrink it. The bottom
          // bar takes the home-indicator inset, so its colour runs to the edge (§2.7).
          form === 'fullscreen' &&
            'inset-x-0 top-0 left-0 flex h-(--app-height,100dvh) max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 border-0 px-0 pt-(--safe-top) pb-0 shadow-none has-[[data-slot=dialog-header]]:pt-(--safe-top) sm:max-w-none'
        )}
        {...props}
      >
        <DialogFormContext.Provider value={value}>{children}</DialogFormContext.Provider>
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className={cn(
              "text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-line-focus rounded-control absolute top-4 right-4 z-10 flex size-8 items-center justify-center outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
              // A 36 touch target, centred on the 64 header.
              // The kit's boxed icon button (M50, M51), as the Sheet Header close.
              form === 'dialog' &&
                "bg-surface-hover text-text-secondary active:bg-surface-selected top-3.5 right-3 size-9 [&_svg:not([class*='size-'])]:size-[18px]",
              form === 'fullscreen' &&
                'active:bg-surface-hover top-[calc(var(--safe-top,0px)+8px)] right-3 size-9'
            )}
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
 * feature colour. In a sheet it is the kit's Sheet Header (tile 40, title 18/800, close 36), and it
 * stays at the top while the body scrolls.
 */
function DialogHeader({
  className,
  icon,
  feature = 'accent',
  children,
  ...props
}: React.ComponentProps<'div'> & { icon?: React.ReactNode; feature?: Feature }) {
  const { form, close } = React.useContext(DialogFormContext)

  if (form === 'sheet') {
    const text = sheetHeaderText(children, DialogTitle, DialogDescription)
    if (text) {
      return (
        <SheetHeader
          icon={icon}
          feature={feature}
          title={text.title}
          subtitle={text.subtitle}
          close={close}
          className={cn('sticky top-0 z-10 bg-inherit', className)}
        />
      )
    }
    // Other children: the same look, and the sheet's own (screen reader) close.
    return (
      <div
        data-slot="dialog-header"
        className={cn('sticky top-0 z-10 flex shrink-0 items-center gap-3 bg-inherit', className)}
        {...props}
      >
        {icon && (
          <span
            aria-hidden
            className={cn(
              'flex size-10 shrink-0 items-center justify-center [&_svg]:size-5',
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

  return (
    <div
      data-slot="dialog-header"
      className={cn(
        '-mx-[22px] flex items-center gap-3 px-[22px] pt-4 pr-14 text-left',
        form === 'dialog' && '-mx-4 min-h-16 px-4 py-3 pr-14',
        form === 'fullscreen' && 'mx-0 min-h-[52px] shrink-0 px-4 py-2 pr-14',
        className
      )}
      {...props}
    >
      {icon && (
        <span
          aria-hidden
          className={cn(
            'flex size-9 shrink-0 items-center justify-center [&_svg]:size-[18px]',
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

/**
 * The actions. Desktop: a strip with the buttons on the right. Mobile sheet: a stack of 48 buttons
 * that stays at the foot while the body scrolls; the primary or red button is the last child, so
 * it sits at the bottom. Mobile dialog: two buttons share a row in equal halves, the red or primary
 * one last; a label too long for a half stacks them at full width, the red or primary one at the
 * bottom.
 */
function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  const { form } = React.useContext(DialogFormContext)
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        form === 'desktop' &&
          'border-line-hairline -mx-[22px] -mb-[18px] flex flex-col-reverse gap-2 border-t px-[22px] py-3.5 sm:flex-row sm:justify-end',
        form === 'sheet' &&
          'sticky bottom-0 z-10 flex shrink-0 flex-col gap-1.5 bg-inherit [&>*]:w-full',
        form === 'dialog' &&
          'border-line-hairline -mx-4 -mb-[18px] flex flex-wrap gap-2 border-t px-4 py-3.5 [&>*]:min-w-[calc(50%-4px)] [&>*]:flex-[1_1_auto]',
        form === 'fullscreen' &&
          'mt-auto flex shrink-0 flex-col gap-1.5 px-4 pt-3 pb-(--safe-bottom) [&>*]:w-full',
        form !== 'desktop' && TOUCH_BUTTONS,
        // Two half-width buttons: 12 side padding keeps "Delete channel" with its icon on one row
        // at 393 (M51). An iPhone SE stacks them.
        form === 'dialog' && '[&>[data-slot=button]]:px-3',
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
