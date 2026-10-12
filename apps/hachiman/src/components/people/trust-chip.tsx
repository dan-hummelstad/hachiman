import { ShieldAlert, type LucideIcon } from 'lucide-react'
import type { SenderTrust } from '@hachiman/crypto'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import { useContactTrust } from '@/components/people/use-contact-trust'
import { useLayout } from '@/hooks/use-layout'
import { formatDayMonth } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openDialog } from '@/stores/dialogStore'
import {
  TRUST_LOOK,
  lookFor,
  shownTrust,
  trustButtonLabel,
  type KeyChangeSeverity
} from './trust-look'

const SIZE = {
  sm: 'h-[22px] gap-1 px-2 text-[11.5px] [&_svg]:size-3.5',
  md: 'rounded-control h-8 gap-1.5 px-2.5 text-[13px] leading-none [&_svg]:size-4'
} as const

/**
 * The trust state of a contact as a chip. With `onClick` it is a button. `keyChange` is the
 * severity of a pending key change (`useMobileKeyChange`): a notice change looks gold.
 */
export function TrustChip({
  state,
  keyChange,
  size = 'sm',
  onClick,
  className
}: {
  state: SenderTrust
  keyChange?: KeyChangeSeverity | null
  size?: keyof typeof SIZE
  onClick?: () => void
  className?: string
}): React.JSX.Element {
  const look = lookFor(state, keyChange)
  const classes = cn(
    'inline-flex shrink-0 items-center font-bold',
    SIZE[size],
    look.chip,
    onClick &&
      'focus-visible:outline-line-focus transition-opacity outline-none hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-1',
    className
  )
  const body = (
    <>
      <look.Icon aria-hidden />
      {look.label}
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className={classes}>
      {body}
    </button>
  ) : (
    <span className={classes}>{body}</span>
  )
}

/**
 * The severity of the pending key change of `userId` on the mobile layout, else null. The gold
 * "Not verified" look of a notice change is mobile only for now (docs/ios-mobile-ui-spec.md 6.1,
 * decision 3), so the desktop keeps red "Key changed".
 */
// eslint-disable-next-line react-refresh/only-export-components -- the DM intro and profile use it.
export function useMobileKeyChange(userId: string | undefined): KeyChangeSeverity | null {
  const mobile = useLayout() === 'mobile'
  const severity = useCryptoStore(
    (s) => s.keyChanges.find((k) => k.userId === userId)?.severity ?? null
  )
  return mobile ? severity : null
}

/** The fill and icon colour of the trust button per shown state (M7 gold, M57 green). */
const BUTTON_TINT: Record<SenderTrust, string> = {
  verified: 'bg-feature-voice/12 text-feature-voice',
  tofu: 'bg-feature-event/10 text-feature-event',
  changed: 'bg-feature-danger/12 text-feature-danger',
  unknown: 'text-text-tertiary'
}

/** M7 draws the gold "Not verified" shield with "!", not the "?" of the chip. */
const BUTTON_ICON: Partial<Record<SenderTrust, LucideIcon>> = { tofu: ShieldAlert }

/**
 * The trust of the other person of a 1:1 DM in the mobile header (M7, M57): a 36 button with the
 * shield only. The label carries the state and its day. A tap opens the verification sheet (B1).
 * Off while the trust loads or cannot be read, and for a user without a key (nothing to verify).
 */
export function TrustButton({ userId, name }: { userId: string; name: string }): React.JSX.Element {
  const { trust, error } = useContactTrust(userId)
  const keyChange = useMobileKeyChange(userId)
  const shown = trust ? shownTrust(trust.state, keyChange) : 'unknown'
  const Icon = BUTTON_ICON[shown] ?? TRUST_LOOK[shown].Icon
  const label = trust
    ? trustButtonLabel({
        name,
        state: trust.state,
        keyChange,
        verifiedOn: formatDayMonth(trust.verifiedAt)
      })
    : (error ?? 'Reading the security key…')
  return (
    <button
      type="button"
      aria-label={label}
      disabled={shown === 'unknown'}
      onClick={() => openDialog({ kind: 'verification', userId })}
      className={cn(
        KIT_ICON_BUTTON,
        'active:brightness-125 disabled:opacity-100',
        BUTTON_TINT[shown]
      )}
    >
      <Icon aria-hidden />
    </button>
  )
}
