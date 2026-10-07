import { useCustomStatus } from '@/hooks/use-custom-status'
import { cn } from '@/lib/utils'

/**
 * The custom status of a user (N16), one truncated line. Renders nothing without one. The text is
 * chosen by the user and shown as typed.
 */
export function CustomStatusLine({
  userId,
  className
}: {
  userId: string
  className?: string
}): React.JSX.Element | null {
  const status = useCustomStatus(userId)
  if (!status?.text) return null
  return (
    <span
      title={status.text}
      className={cn('text-text-secondary truncate text-xs leading-4', className)}
    >
      {status.text}
    </span>
  )
}
