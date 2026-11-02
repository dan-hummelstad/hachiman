import { X } from 'lucide-react'
import type { Role } from '@hachiman/client'
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
      /** The mobile kit chip (22, 12/600). It has no ✕: remove the role from a sheet. */
      size: 'sm'
      onRemove?: never
      removeLabel?: never
    }
)

/** A role pill: the name (roles are neutral), optionally with a remove button. */
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
          ? 'bg-surface-raised text-text-primary flex h-[22px] items-center rounded-[6px] px-2 text-xs font-semibold'
          : 'rounded-check bg-surface-raised text-text-primary flex h-6 items-center gap-1.5 px-2 text-xs font-semibold',
        className
      )}
    >
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
