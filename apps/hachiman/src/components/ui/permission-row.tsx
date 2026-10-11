import { Permissions } from '@hachiman/client'
import { ListGroup } from '@/components/mobile/list'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/**
 * One permission line in a settings list: label + hint on the left, the control on the right.
 * `size="touch"` is the M53 row: padding 11/14, title 15/700 with the `badge` beside it (it wraps
 * under the title when it does not fit), hint 12.5/500, and the whole row is the control's label,
 * so a tap anywhere on it toggles a Switch.
 */
export function PermissionRow({
  label,
  hint,
  htmlFor,
  badge,
  dim = false,
  size = 'default',
  className,
  children
}: {
  label: string
  hint: string
  /** The control's id; makes the label text clickable (e.g. for a Switch). */
  htmlFor?: string
  /** Touch only: a tag after the title ("VIA ADMINISTRATOR"). */
  badge?: React.ReactNode
  /** Touch only: dims the text (a permission that another one gives). */
  dim?: boolean
  size?: 'default' | 'touch'
  /** Touch only: classes of the row. */
  className?: string
  /** The control (Switch, tri-state toggle…). */
  children: React.ReactNode
}): React.JSX.Element {
  if (size === 'touch') {
    const body = (
      <>
        <span className={cn('grid min-w-0 flex-1 gap-0.5', dim && 'opacity-50')}>
          <span className="text-text-primary flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] leading-[18px] font-bold">
            {label}
            {badge}
          </span>
          <span className="text-text-tertiary text-[12.5px] leading-[18px] font-medium">
            {hint}
          </span>
        </span>
        {children}
      </>
    )
    const row = cn('flex items-center gap-3 px-3.5 py-[11px]', className)
    return htmlFor ? (
      <label htmlFor={htmlFor} className={cn(row, 'cursor-pointer')}>
        {body}
      </label>
    ) : (
      <div className={row}>{body}</div>
    )
  }
  const text = (
    <>
      <span className="text-sm">{label}</span>
      <span className="text-muted-foreground text-xs leading-4">{hint}</span>
    </>
  )
  return (
    <div className="flex items-center gap-4 py-2.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="grid flex-1 cursor-pointer">
          {text}
        </label>
      ) : (
        <span className="grid flex-1">{text}</span>
      )}
      {children}
    </div>
  )
}

/** One switch of a `PermissionList`. */
export interface PermissionItem {
  name: string
  bit: number
  label: string
  hint: string
}

/**
 * The permission switches of a role (G2, M53), one per item. With Administrator on, every other
 * row shows "VIA ADMINISTRATOR", dims, and stays on and disabled. `size="touch"`: the M53 list, a
 * square group with hairline dividers and 46 × 28 switches.
 */
export function PermissionList({
  items,
  value,
  onChange,
  disabled = false,
  size = 'default'
}: {
  items: readonly PermissionItem[]
  /** The permission bits. */
  value: number
  onChange: (value: number) => void
  disabled?: boolean
  size?: 'default' | 'touch'
}): React.JSX.Element {
  const admin = (value & Permissions.ADMINISTRATOR) !== 0
  const rows = items.map((p) => {
    const viaAdmin = admin && p.bit !== Permissions.ADMINISTRATOR
    const id = `perm-${p.name}`
    const toggle = (
      <Switch
        id={id}
        size={size}
        checked={viaAdmin || (value & p.bit) === p.bit}
        disabled={disabled || viaAdmin}
        onCheckedChange={(v) => onChange(v ? value | p.bit : value & ~p.bit)}
      />
    )
    if (size === 'touch') {
      return (
        <PermissionRow
          key={p.name}
          size="touch"
          label={p.label}
          hint={p.hint}
          htmlFor={id}
          dim={viaAdmin}
          badge={
            viaAdmin && (
              <span className="bg-feature-event/12 text-feature-event-text px-[5px] text-[9.5px] leading-[18px] font-extrabold tracking-[0.4px] whitespace-nowrap">
                VIA ADMINISTRATOR
              </span>
            )
          }
        >
          {toggle}
        </PermissionRow>
      )
    }
    return (
      <div key={p.name} className={cn('flex items-center gap-4 py-2.5', viaAdmin && 'opacity-55')}>
        <label htmlFor={id} className="grid min-w-0 flex-1 cursor-pointer">
          <span className="text-label flex items-center gap-2">
            {p.label}
            {viaAdmin && (
              <span className="bg-feature-event/15 text-feature-event-text px-1.5 text-[10px] leading-4 font-extrabold tracking-[0.6px]">
                VIA ADMINISTRATOR
              </span>
            )}
          </span>
          <span className="text-meta text-text-tertiary">{p.hint}</span>
        </label>
        {toggle}
      </div>
    )
  })
  if (size === 'touch') return <ListGroup>{rows}</ListGroup>
  return <div className="divide-line-hairline divide-y">{rows}</div>
}
