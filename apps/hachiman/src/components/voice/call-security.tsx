import { LoaderCircle, Lock, RefreshCw, TriangleAlert } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { useCallSecurity, type CallSecurityKind } from '@/components/voice/use-call-security'
import { cn } from '@/lib/utils'
import { openDialog } from '@/stores/dialogStore'

type LockKind = Exclude<CallSecurityKind, 'none' | 'resync_failed'>

const LOCK: Record<LockKind, { label: string; status: string; className: string }> = {
  secure: {
    label: 'End-to-end encrypted. Verify the call',
    status: 'End-to-end encrypted',
    className: 'text-online'
  },
  securing: { label: 'Setting up encryption…', status: 'Setting up…', className: 'text-idle' },
  resyncing: { label: 'Reconnecting securely…', status: 'Reconnecting…', className: 'text-idle' },
  update_required: {
    label: 'Update required for encrypted calls',
    status: 'Update required',
    className: 'text-dnd'
  }
}

function LockIcon({ kind, className }: { kind: LockKind; className?: string }): React.JSX.Element {
  if (kind === 'secure') return <Lock className={className} />
  if (kind === 'update_required') return <TriangleAlert className={className} />
  return <LoaderCircle className={cn('animate-spin', className)} />
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
      <LockIcon kind={kind} />
    </IconButton>
  )
}

/**
 * The encryption state of the own call as a popover section, with "Verify call" once the call is
 * secure. Renders nothing outside a call.
 */
export function CallSecuritySection(): React.JSX.Element | null {
  const { kind } = useCallSecurity()
  if (kind === 'none' || kind === 'resync_failed') return null
  const { status, className } = LOCK[kind]
  return (
    <div className="mt-3 border-t pt-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold">Encryption</span>
        <span className={cn('flex items-center gap-1 text-xs', className)}>
          <LockIcon kind={kind} className="size-3.5" />
          {status}
        </span>
      </div>
      {kind === 'secure' && (
        <button
          type="button"
          className="hover:bg-accent mt-2 w-full rounded-md border px-2 py-1 text-xs font-medium"
          onClick={() => openDialog({ kind: 'verifyCall' })}
        >
          Verify call
        </button>
      )}
    </div>
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
