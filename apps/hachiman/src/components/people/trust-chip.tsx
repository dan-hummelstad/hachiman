import type { SenderTrust } from '@hachiman/crypto'
import { cn } from '@/lib/utils'
import { TRUST_LOOK } from './trust-look'

const SIZE = {
  sm: 'h-[22px] gap-1 px-2 text-[11.5px] [&_svg]:size-3.5',
  md: 'rounded-control h-8 gap-1.5 px-2.5 text-[13px] leading-none [&_svg]:size-4'
} as const

/** The trust state of a contact as a chip. With `onClick` it is a button. */
export function TrustChip({
  state,
  size = 'sm',
  onClick,
  className
}: {
  state: SenderTrust
  size?: keyof typeof SIZE
  onClick?: () => void
  className?: string
}): React.JSX.Element {
  const look = TRUST_LOOK[state]
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
