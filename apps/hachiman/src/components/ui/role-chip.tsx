import { X } from 'lucide-react'
import type { Role } from '@hachiman/client'
import { hexColor } from '@/lib/model'
import { cn } from '@/lib/utils'

/** A role pill: colour swatch + name, optionally with a remove button. */
export function RoleChip({
  role,
  onRemove,
  removeLabel,
  className
}: {
  role: Pick<Role, 'name' | 'color'>
  /** Shows an ✕ that calls this. */
  onRemove?: () => void
  /** Accessible name for the ✕ (default "Remove <role>"). */
  removeLabel?: string
  className?: string
}): React.JSX.Element {
  return (
    <span className={cn('bg-card flex h-6 items-center gap-1.5 border px-1.5 text-xs', className)}>
      <span
        aria-hidden
        className="size-2 shrink-0"
        style={{ background: role.color ? hexColor(role.color) : 'var(--muted-foreground)' }}
      />
      {role.name}
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel ?? `Remove ${role.name}`}
          className="text-muted-foreground hover:text-foreground"
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}
