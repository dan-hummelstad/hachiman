import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
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
  /** Right-aligned action buttons in the footer strip. */
  actions?: React.ReactNode
  className?: string
}

/** Arc dialog (icon tile, title and subtitle, body, footer actions) on the shared Dialog. */
export function ModalWindow(props: ModalWindowProps): React.JSX.Element {
  const { open, onClose, title, description, icon, feature, children, actions, className } = props
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn('sm:max-w-[500px]', className)}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader icon={icon} feature={feature}>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        {actions && <DialogFooter>{actions}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}
