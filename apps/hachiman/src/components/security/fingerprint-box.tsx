import { safetyRows } from '@/components/security/verification-model'
import { cn } from '@/lib/utils'

/**
 * A key fingerprint in hex as groups of 4 ("7C2E"), upper case. Spaces and colons in `hex` go
 * away, so a fingerprint in any common notation gives the same groups.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function fingerprintGroups(hex: string): string[] {
  return (
    hex
      .replace(/[\s:]/g, '')
      .toUpperCase()
      .match(/.{1,4}/g) ?? []
  )
}

/**
 * The key fingerprint of a device (M24), to compare with the screen of that device: a section
 * label, then the hex in mono 20/500, 4 groups per row, and an optional helper line. VoiceOver
 * reads each row spelled out. No fingerprint: nothing renders (the API has no per-device
 * fingerprint yet, docs/ios-mobile-ui-spec.md section 5).
 */
export function FingerprintBox({
  fingerprint,
  label = 'Key fingerprint',
  hint,
  className
}: {
  fingerprint: string | null | undefined
  label?: string
  hint?: React.ReactNode
  className?: string
}): React.JSX.Element | null {
  if (!fingerprint) return null
  const rows = safetyRows(fingerprintGroups(fingerprint))
  return (
    <div data-slot="fingerprint-box" className={cn('flex flex-col gap-2.5', className)}>
      <h3 className="section-label tracking-[0.8px]">{label}</h3>
      <div
        role="group"
        aria-label={label}
        className="border-line-hairline bg-surface-sunken text-text-primary flex flex-col gap-1.5 border px-4 py-3.5 font-mono text-[20px] leading-[26px] font-medium tracking-[0.6px]"
      >
        {rows.map((row) => (
          <div key={row.label}>
            <span className="sr-only">{row.label}</span>
            <span aria-hidden>{row.groups.join(' ')}</span>
          </div>
        ))}
      </div>
      {hint && (
        <p className="text-text-tertiary text-[12.5px] leading-[1.45] font-medium">{hint}</p>
      )}
    </div>
  )
}
