import { useId } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { Guild } from '@hachiman/client'
import { ListGroup, SectionLabel } from '@/components/mobile/list'
import { GuildTile } from '@/components/ui/guild-tile'
import { Switch } from '@/components/ui/switch'
import { radioStep } from '@/lib/roving'
import { cn } from '@/lib/utils'

/** The mono caps heading of a section of a settings page. */
export function SettingsCap({
  children,
  id,
  className
}: {
  children: React.ReactNode
  id?: string
  className?: string
}): React.JSX.Element {
  return (
    <h2
      id={id}
      className={cn(
        'text-text-disabled font-mono text-[9px] leading-3 tracking-[1.5px] uppercase',
        className
      )}
    >
      {children}
    </h2>
  )
}

/** The hairline between two sections of a settings page. */
export function SettingsRule(): React.JSX.Element {
  return <div aria-hidden className="bg-line-hairline my-5 h-px" />
}

const ROW = 'flex min-h-[54px] items-center gap-4 py-2 mobile:min-h-12 mobile:px-3.5'

function RowText({
  title,
  hint
}: {
  title: React.ReactNode
  hint?: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="min-w-0 flex-1">
      <span className="text-text-primary mobile:text-[13.5px] block text-[14px] font-medium">
        {title}
      </span>
      {hint && (
        <span className="text-text-tertiary mobile:text-[11.5px] mobile:text-text-disabled mt-[3px] block text-[12.5px] leading-[15px]">
          {hint}
        </span>
      )}
    </span>
  )
}

/** A title and a hint on the left, a switch on the right. The whole row is the switch's label. */
export function ToggleRow({
  title,
  hint,
  checked,
  onChange,
  disabled,
  trailing,
  className
}: {
  title: React.ReactNode
  hint?: React.ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  trailing?: React.ReactNode
  className?: string
}): React.JSX.Element {
  const id = useId()
  return (
    <div className={cn(ROW, className)}>
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <RowText title={title} hint={hint} />
      </label>
      {trailing}
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="mobile:h-7 mobile:w-[46px]"
      />
    </div>
  )
}

/** A title and a hint on the left, a control (a select) on the right. */
export function SelectRow({
  title,
  hint,
  children
}: {
  title: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={ROW}>
      <RowText title={title} hint={hint} />
      {children}
    </div>
  )
}

/** A mono caps label over a field. */
export function FieldBlock({
  label,
  children,
  className
}: {
  label: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('grid gap-[7px]', className)}>
      <span className="text-text-disabled font-mono text-[9px] tracking-[1.2px] uppercase">
        {label}
      </span>
      {children}
    </div>
  )
}

export const READ_FIELD =
  'rounded-control border-line-hairline bg-surface-sunken text-text-primary mobile:h-[52px] mobile:rounded-[14px] mobile:border-line-strong mobile:px-4 mobile:text-[15px] flex h-[42px] items-center gap-0.5 border px-3 text-sm'

/** A read-only value in the look of a field. */
export function ReadField({
  prefix,
  children,
  className
}: {
  prefix?: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn(READ_FIELD, className)}>
      {prefix && <span className="text-text-disabled">{prefix}</span>}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

/** A block that answers a question: `you` for what waits on you, `live` for what happens now. */
export function AnswerBlock({
  tone,
  icon,
  cap,
  title,
  body,
  actions
}: {
  tone: 'you' | 'live'
  icon?: React.ReactNode
  cap: React.ReactNode
  title?: React.ReactNode
  body?: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  const you = tone === 'you'
  return (
    <div className={cn('flex items-start gap-4 p-[18px]', you ? 'bg-you-tint' : 'bg-live-tint')}>
      {icon && (
        <span aria-hidden className={cn('mt-0.5 shrink-0', you ? 'text-you' : 'text-live')}>
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'font-mono text-[9px] font-semibold tracking-[1.5px] uppercase',
            you ? 'text-you-text' : 'text-live-text'
          )}
        >
          {cap}
        </p>
        {title && <p className="text-text-primary mt-1.5 text-[15px] font-semibold">{title}</p>}
        {body && <p className="text-text-tertiary mt-1 text-[12.5px] leading-[19px]">{body}</p>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 gap-2 self-center">{actions}</div>}
    </div>
  )
}

/** The grouped card of the mobile settings pages. */
export function MobileCard({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <ListGroup
      className={cn(
        'border-line-hairline bg-surface-panel overflow-hidden rounded-[14px] border',
        className
      )}
    >
      {children}
    </ListGroup>
  )
}

export function MobileCap({
  children,
  id
}: {
  children: React.ReactNode
  id?: string
}): React.JSX.Element {
  return (
    <SectionLabel id={id} className="text-text-disabled px-0 pt-0 font-mono text-[9px] tracking-[1.2px]">
      {children}
    </SectionLabel>
  )
}

export function MobileNote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-text-disabled px-1 text-[11.5px] leading-[17px]">{children}</p>
}

/** The mobile radio card: one row per option, the chosen one has a here ring. */
export function RadioRows<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled
}: {
  label: string
  value: T
  options: readonly { value: T; title: string; hint?: string }[]
  onChange: (value: T) => void
  disabled?: boolean
}): React.JSX.Element {
  const current = Math.max(
    options.findIndex((o) => o.value === value),
    0
  )
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = radioStep(current, options.length, e.key)
    if (next === null) return
    e.preventDefault()
    onChange(options[next].value)
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }
  return (
    <MobileCard>
      <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="contents">
        {options.map((o, i) => {
          const on = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={i === current ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(o.value)}
              className="active:bg-surface-hover flex min-h-[46px] w-full items-center gap-3 px-3.5 py-3 text-left disabled:opacity-50"
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px]',
                  on ? 'border-here' : 'border-line-strong'
                )}
              >
                {on && <span className="bg-here size-2.5 rounded-full" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-text-primary block text-[14.5px] font-semibold">
                  {o.title}
                </span>
                {o.hint && (
                  <span className="text-text-disabled block text-[11.5px] leading-4">{o.hint}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </MobileCard>
  )
}

/** Three cards in a row to choose one of them (desktop "What reaches you"). */
export function ChoiceCards<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled
}: {
  label: string
  value: T
  options: readonly { value: T; title: string; sub: string; icon: React.ReactNode }[]
  onChange: (value: T) => void
  disabled?: boolean
}): React.JSX.Element {
  const current = Math.max(
    options.findIndex((o) => o.value === value),
    0
  )
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = radioStep(current, options.length, e.key)
    if (next === null) return
    e.preventDefault()
    onChange(options[next].value)
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="grid grid-cols-3 gap-3"
    >
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === current ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-control flex min-h-[72px] flex-col gap-2 border p-3.5 text-left disabled:opacity-50',
              on
                ? 'bg-surface-selected border-transparent'
                : 'border-line-hairline hover:bg-surface-hover'
            )}
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn('[&_svg]:size-3.5', on ? 'text-text-primary' : 'text-text-tertiary')}
              >
                {o.icon}
              </span>
              <span
                className={cn(
                  'text-[13.5px]',
                  on ? 'text-text-primary font-semibold' : 'text-text-secondary font-medium'
                )}
              >
                {o.title}
              </span>
              {on && <Check aria-hidden className="text-text-primary ml-auto size-3.5" />}
            </span>
            <span className="text-text-tertiary text-[12px] leading-[17px]">{o.sub}</span>
          </button>
        )
      })}
    </div>
  )
}

/** A space with a value on the right; a button when it opens something. */
export function SpaceRow({
  guild,
  memberCount,
  current,
  value,
  onClick
}: {
  guild: Pick<Guild, 'name' | 'icon'>
  memberCount?: number
  current?: boolean
  value?: React.ReactNode
  onClick?: () => void
}): React.JSX.Element {
  const body = (
    <>
      <GuildTile
        guild={guild}
        className={cn('size-[30px] rounded-[7px] text-[11px]', current && 'bg-here text-on-here')}
      />
      <span className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              'truncate text-[13.5px]',
              current ? 'text-text-primary font-semibold' : 'text-text-secondary font-medium'
            )}
          >
            {guild.name}
          </span>
          {current && (
            <span className="text-here-text font-mono text-[8.5px] tracking-[0.9px] whitespace-nowrap">
              YOU ARE HERE
            </span>
          )}
        </span>
        {memberCount !== undefined && (
          <span className="cap-sm block">
            {memberCount} {memberCount === 1 ? 'MEMBER' : 'MEMBERS'}
          </span>
        )}
      </span>
      {value !== undefined && (
        <span className="text-text-secondary shrink-0 text-[12.5px]">{value}</span>
      )}
      {onClick && <ChevronDown aria-hidden className="text-text-disabled size-3.5 shrink-0" />}
    </>
  )
  const cls = 'flex min-h-11 w-full items-center gap-3'
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, 'hover:bg-surface-hover')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  )
}

const RANGE_THUMB =
  '[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-text-primary [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-line-strong [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-text-primary [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-line-strong'

/** The desktop slider: a thin track filled with `here` up to `fraction`. */
export function RangeInput({
  fraction,
  className,
  ...input
}: { fraction: number } & Omit<React.ComponentProps<'input'>, 'type'>): React.JSX.Element {
  const p = Math.round(Math.min(1, Math.max(0, fraction)) * 100)
  return (
    <input
      type="range"
      {...input}
      style={{
        background: `linear-gradient(to right, var(--here) ${p}%, var(--line-strong) ${p}%)`
      }}
      className={cn(
        'h-1.5 w-full cursor-pointer appearance-none rounded-[3px] outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-line-focus disabled:cursor-not-allowed disabled:opacity-50',
        RANGE_THUMB,
        className
      )}
    />
  )
}
