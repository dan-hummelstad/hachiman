import { LoaderCircle, Lock, RefreshCw, TriangleAlert } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { useCallSecurity, type CallSecurityKind } from '@/components/voice/use-call-security'
import { cn } from '@/lib/utils'
import { openDialog } from '@/stores/dialogStore'

const LOCK: Record<
  Exclude<CallSecurityKind, 'none' | 'resync_failed'>,
  { label: string; className: string }
> = {
  secure: { label: 'End-to-end encrypted. Verify the call', className: 'text-online' },
  securing: { label: 'Setting up encryption…', className: 'text-idle' },
  resyncing: { label: 'Reconnecting securely…', className: 'text-idle' },
  update_required: { label: 'Update required for encrypted calls', className: 'text-dnd' }
}

/**
 * The lock of the own call. It opens the "Verify call" dialog (epoch code and safety numbers).
 * Renders nothing outside a call.
 */
export function CallLockButton({ size }: { size?: 'sm' | 'md' }): React.JSX.Element | null {
  const { kind } = useCallSecurity()
  if (kind === 'none' || kind === 'resync_failed') return null
  const { label, className } = LOCK[kind]
  return (
    <IconButton
      label={label}
      size={size}
      className={cn(className, 'hover:text-current')}
      onClick={() => openDialog({ kind: 'verifyCall' })}
    >
      {kind === 'secure' ? (
        <Lock />
      ) : kind === 'update_required' ? (
        <TriangleAlert />
      ) : (
        <LoaderCircle className="animate-spin" />
      )}
    </IconButton>
  )
}

/**
 * One line for a call state that needs words: the automatic rejoin after media close 4013, its
 * failure, or 4012 (this client is too old). Renders nothing in the other states.
 */
export function CallSecurityBanner({
  className
}: {
  className?: string
}): React.JSX.Element | null {
  const { kind } = useCallSecurity()
  if (kind === 'resyncing')
    return (
      <p
        role="status"
        className={cn('text-idle flex items-center gap-1.5 text-xs leading-4', className)}
      >
        <RefreshCw className="size-3.5 shrink-0 animate-spin" aria-hidden />
        Reconnecting securely. The call keys are made again.
      </p>
    )
  if (kind === 'resync_failed')
    return (
      <p
        role="alert"
        className={cn('text-dnd flex items-center gap-1.5 text-xs leading-4', className)}
      >
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        Could not reconnect securely. Join the call again.
      </p>
    )
  if (kind === 'update_required')
    return (
      <p
        role="alert"
        className={cn('text-dnd flex items-center gap-1.5 text-xs leading-4', className)}
      >
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        Update required. This version of Hachiman cannot join encrypted calls.
      </p>
    )
  return null
}
