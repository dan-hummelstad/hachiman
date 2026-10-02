import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

interface ModalWindowProps {
  open: boolean
  onClose: () => void
  title: string
  /** One plain line under the title bar. */
  description?: string
  children?: React.ReactNode
  /** Right-aligned action buttons in the footer strip. */
  actions?: React.ReactNode
  className?: string
}

/** Narrow old-messenger window (title bar, body, action strip) on the shared Dialog. */
export function ModalWindow(props: ModalWindowProps): React.JSX.Element {
  const { open, onClose, title, description, children, actions, className } = props
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn('sm:max-w-[440px]', className)}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        {actions && <DialogFooter>{actions}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}
