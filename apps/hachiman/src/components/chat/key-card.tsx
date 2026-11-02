import { ShieldCheck } from 'lucide-react'
import { securityText } from '@/components/people/trust-look'
import { formatDayMonth } from '@/lib/time-format'

/**
 * The key card of a verified contact in the mobile DM intro (M57): "Verified 2 Oct" and the
 * explainer, on a raised card. The fingerprint of the mock waits for the contact key fingerprint
 * (docs/ios-mobile-ui-spec.md §5).
 */
export function KeyCard({
  name,
  verifiedAt
}: {
  name: string
  /** TrustInfo.verifiedAt: null when the store has no time for the verification. */
  verifiedAt: string | null
}): React.JSX.Element {
  const day = formatDayMonth(verifiedAt)
  return (
    <section
      aria-label="Security key"
      className="border-line-strong bg-surface-raised rounded-option flex flex-col gap-2 border px-3.5 py-[17px]"
    >
      <p className="text-text-primary flex items-center gap-1.5 text-[14px] leading-[18px] font-semibold">
        <ShieldCheck className="size-4 shrink-0" aria-hidden />
        {day ? `Verified ${day}` : 'Verified'}
      </p>
      <p className="text-text-secondary text-[13px] leading-[1.45]">
        {securityText({ name, state: 'verified', verifiedOn: day, error: null })}
      </p>
    </section>
  )
}
