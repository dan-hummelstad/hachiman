import { X } from 'lucide-react'
import type { Role } from '@hachiman/client'
import { hexColor } from '@/lib/model'
import { cn } from '@/lib/utils'

type RoleChipProps = {
  role: Pick<Role, 'name' | 'color'>
  className?: string
} & (
  | {
      size?: 'default'
      /** Shows an ✕ that calls this. */
      onRemove?: () => void
      /** Accessible name for the ✕ (default "Remove <role>"). */
      removeLabel?: string
    }
  | {
      /** The mobile kit chip (22, dot 7, 12/700). It has no ✕: remove the role from a sheet. */
      size: 'sm'
      onRemove?: never
      removeLabel?: never
    }
)

/** A role pill: colour swatch + name, optionally with a remove button. */
export function RoleChip({
  role,
  onRemove,
  removeLabel,
  size = 'default',
  className
}: RoleChipProps): React.JSX.Element {
  const sm = size === 'sm'
  return (
    <span
      className={cn(
        sm
          ? 'bg-surface-raised text-text-primary flex h-[22px] items-center gap-1.5 rounded-[6px] pr-2 pl-[7px] text-xs font-bold'
          : 'rounded-check bg-surface-raised text-text-primary flex h-6 items-center gap-1.5 px-2 text-xs font-semibold',
        className
      )}
    >
      <span
        aria-hidden
        className={sm ? 'size-[7px] shrink-0' : 'size-2 shrink-0'}
        style={{ background: role.color ? hexColor(role.color) : 'var(--text-secondary)' }}
      />
      {role.name}
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel ?? `Remove ${role.name}`}
          className="text-text-secondary hover:text-text-primary"
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}
