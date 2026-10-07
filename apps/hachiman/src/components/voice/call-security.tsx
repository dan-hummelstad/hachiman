import { LoaderCircle, Lock, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { IconButton } from '@/components/ui/icon-button'
import { useCallSecurity, type CallSecurityKind } from '@/components/voice/use-call-security'
import { cn } from '@/lib/utils'
import { openDialog } from '@/stores/dialogStore'

type LockKind = Exclude<CallSecurityKind, 'none' | 'resync_failed'>

const LOCK: Record<LockKind, { label: string; status: string; className: string }> = {
  secure: {
    label: 'End-to-end encrypted. Verify the call',
    status: 'End-to-end encrypted',
    className: 'text-feature-voice-text'
  },
  securing: {
    label: 'Setting up encryption…',
    status: 'Setting up…',
    className: 'text-feature-event-text'
  },
  resyncing: {
    label: 'Reconnecting securely…',
    status: 'Reconnecting…',
    className: 'text-feature-event-text'
  },
  update_required: {
    label: 'Update required for encrypted calls',
    status: 'Update required',
    className: 'text-feature-danger-text'
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
    <div className="border-line-hairline mt-3 border-t pt-3">
      <div className="flex items-center justify-between text-sm">
        <span className="section-label">Encryption</span>
        <span className={cn('flex items-center gap-1 text-xs', className)}>
          <LockIcon kind={kind} className="size-3.5" />
          {status}
        </span>
      </div>
      {kind === 'secure' && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2 w-full"
          onClick={() => openDialog({ kind: 'verifyCall' })}
        >
          Verify call
        </Button>
      )}
    </div>
  )
}

const BANNER: Partial<
  Record<CallSecurityKind, { tone: 'caution' | 'danger'; role: 'status' | 'alert'; text: string }>
> = {
  resyncing: {
    tone: 'caution',
    role: 'status',
    text: 'Reconnecting securely. The call keys are made again.'
  },
  resync_failed: {
    tone: 'danger',
    role: 'alert',
    text: 'Could not reconnect securely. Join the call again.'
  },
  update_required: {
    tone: 'danger',
    role: 'alert',
    text: 'Update required. This version of Hachiman cannot join encrypted calls.'
  }
}

/**
 * A callout for a call state that needs words: the automatic rejoin after media close 4013
 * (caution), its failure, or 4012 (this client is too old) (danger). Renders nothing in the other
 * states.
 */
export function CallSecurityBanner({
  className
}: {
  className?: string
}): React.JSX.Element | null {
  const { kind } = useCallSecurity()
  const banner = BANNER[kind]
  if (!banner) return null
  return (
    <div role={banner.role} className={className}>
      <Callout tone={banner.tone}>{banner.text}</Callout>
    </div>
  )
}
