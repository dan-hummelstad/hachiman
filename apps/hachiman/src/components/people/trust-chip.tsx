import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { TRUST_LOOK, useContactSecurity } from '@/components/people/use-contact-security'
import { cn } from '@/lib/utils'
import { openDialog } from '@/stores/dialogStore'

/**
 * The trust chip of a DM header (E2, E3): gold "Not verified", green "Verified", coral "Key
 * changed". A click opens the verification dialog. Nothing while the trust is unknown.
 */
export function TrustChip({ userId }: { userId: string }): React.JSX.Element | null {
  const { trust } = useContactSecurity(userId)
  if (!trust || trust.state === 'unknown') return null
  const look = TRUST_LOOK[trust.state]
  const Icon =
    trust.state === 'verified'
      ? ShieldCheck
      : trust.state === 'changed'
        ? ShieldAlert
        : ShieldQuestion
  return (
    <button
      type="button"
      onClick={() => openDialog({ kind: 'verification', userId })}
      className={cn(
        'rounded-control focus-visible:outline-line-focus inline-flex h-8 items-center gap-1.5 px-3 text-[13px] font-bold focus-visible:outline-2',
        look.chip
      )}
    >
      <Icon className="size-4" aria-hidden />
      {look.label}
    </button>
  )
}
