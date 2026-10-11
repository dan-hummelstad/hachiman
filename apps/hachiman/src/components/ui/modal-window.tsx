import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  type DialogPresentation
} from '@/components/ui/dialog'
import type { Feature } from '@/components/ui/feature'
import { cn } from '@/lib/utils'

interface ModalWindowProps {
  open: boolean
  onClose: () => void
  title: string
  /** The subtitle: one plain line under the title. */
  description?: string
  /** Icon in the header tile, in the colour of `feature` (default accent). */
  icon?: React.ReactNode
  feature?: Feature
  children?: React.ReactNode
  /**
   * Right-aligned action buttons in the footer strip. Primary last: on the mobile layout they
   * stack as 48 buttons and the last one sits at the bottom.
   */
  actions?: React.ReactNode
  className?: string
  /** The form on the mobile layout (default a sheet). */
  presentation?: DialogPresentation
  /** Where the focus goes on close; `preventDefault` keeps Radix from moving it. */
  onCloseAutoFocus?: (event: Event) => void
}

/**
 * Arc dialog (icon tile, title and subtitle, body, footer actions) on the shared Dialog. On the
 * mobile layout it is a sheet: the Sheet Header, a scrolling body and the actions at the foot.
 */
export function ModalWindow(props: ModalWindowProps): React.JSX.Element {
  const { open, onClose, title, description, icon, feature, children, actions, className } = props
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        presentation={props.presentation}
        onCloseAutoFocus={props.onCloseAutoFocus}
        className={cn('sm:max-w-[500px]', className)}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader icon={icon} feature={feature} title={title} description={description} />
        {children}
        {actions && <DialogFooter>{actions}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}
