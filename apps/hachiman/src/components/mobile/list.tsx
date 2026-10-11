import { useId } from 'react'
import { ArrowUpRight, Check, ChevronRight, Copy } from 'lucide-react'
import { FEATURE_TILE, type Feature } from '@/components/ui/feature'
import { Switch } from '@/components/ui/switch'
import { useCopy } from '@/hooks/use-copy'
import { cn } from '@/lib/utils'

/** Mobile / Section Label (kit u9pnuQ): 11.5/800 caps over a list group, padding 4/4/0/4. */
export function SectionLabel({
  className,
  ...props
}: React.ComponentProps<'h2'>): React.JSX.Element {
  return (
    <h2 data-slot="section-label" className={cn('section-label px-1 pt-1', className)} {...props} />
  )
}

/**
 * List Group: a square box with hairline dividers between its rows. The danger tone tints the box
 * red (the "Sign out" group of M29, a danger zone).
 */
export function ListGroup({
  tone = 'default',
  className,
  ...props
}: React.ComponentProps<'div'> & { tone?: 'default' | 'danger' }): React.JSX.Element {
  return (
    <div
      data-slot="list-group"
      className={cn(
        'divide-line-hairline flex flex-col divide-y border',
        tone === 'danger'
          ? 'bg-feature-danger/5 border-feature-danger/20'
          : 'border-line-hairline bg-white/2',
        className
      )}
      {...props}
    />
  )
}

/**
 * The tile colour of a row: a feature colour, pink activity (Notifications, M29) or neutral grey
 * ("Help and support").
 */
export type ListRowTile = Feature | 'activity' | 'neutral'

const TILE: Record<ListRowTile, string> = {
  ...FEATURE_TILE,
  activity: 'bg-feature-activity/15 text-feature-activity',
  neutral: 'bg-surface-hover text-text-secondary'
}

export interface ListRowToggle {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

interface ListRowBase {
  /** Icon in the 32 tile (17). No icon: no tile. */
  icon?: React.ReactNode
  /** The tile colour (default accent; danger rows always red). */
  tile?: ListRowTile
  label: React.ReactNode
  /** Second line, 12.5/500. A row with a detail is 54 high, else 46. */
  detail?: React.ReactNode
  /** Short text before the end mark: "3", "Dark", "Mentions". */
  value?: React.ReactNode
  /** Red label and tile, no chevron ("Sign out", "Delete page"). */
  tone?: 'default' | 'danger'
  disabled?: boolean
  className?: string
}

/** What the row does. At most one of these. None: a static row (with an optional `trailing`). */
type ListRowMode =
  | {
      /** A button row with a chevron at the end. */
      onClick: () => void
      /** False hides the chevron (an action rather than a push). */
      chevron?: boolean
      href?: undefined
      toggle?: undefined
      copy?: undefined
      trailing?: undefined
    }
  | {
      /** A link that leaves the app, with an arrow at the end. */
      href: string
      onClick?: undefined
      chevron?: undefined
      toggle?: undefined
      copy?: undefined
      trailing?: undefined
    }
  | {
      /** A switch at the end; the whole row is its label. */
      toggle: ListRowToggle
      onClick?: undefined
      chevron?: undefined
      href?: undefined
      copy?: undefined
      trailing?: undefined
    }
  | {
      /** The whole row copies this text; the copy mark turns into a check. */
      copy: string
      onClick?: undefined
      chevron?: undefined
      href?: undefined
      toggle?: undefined
      trailing?: undefined
    }
  | {
      onClick?: undefined
      chevron?: undefined
      href?: undefined
      toggle?: undefined
      copy?: undefined
      /** Anything at the end of a static row. */
      trailing?: React.ReactNode
    }

export type ListRowProps = ListRowBase & ListRowMode

const ROW =
  'flex w-full items-center gap-3 py-1.5 pr-3.5 pl-3 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-line-focus'
const PRESSABLE = 'active:bg-surface-hover disabled:pointer-events-none disabled:opacity-50'
const MARK = 'text-text-disabled size-[17px] shrink-0'

/** Tile, label and detail, and the value: the part that every row kind shares. */
function RowContent({
  icon,
  tile = 'accent',
  label,
  detail,
  value,
  tone,
  labelId,
  detailId
}: ListRowBase & { labelId?: string; detailId?: string }): React.JSX.Element {
  const danger = tone === 'danger'
  return (
    <>
      {icon && (
        <span
          aria-hidden
          className={cn(
            'flex size-8 shrink-0 items-center justify-center [&_svg]:size-[17px]',
            TILE[danger ? 'danger' : tile]
          )}
        >
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          id={labelId}
          className={cn(
            'truncate text-[15px] leading-[18px] font-bold',
            danger ? 'text-feature-danger-text' : 'text-text-primary'
          )}
        >
          {label}
        </span>
        {detail && (
          <span
            id={detailId}
            className="text-text-tertiary line-clamp-2 text-[12.5px] leading-[15px] font-medium"
          >
            {detail}
          </span>
        )}
      </span>
      {value !== undefined && value !== null && (
        <span className="text-text-tertiary shrink-0 text-[13.5px] leading-4 font-semibold tabular-nums">
          {value}
        </span>
      )}
    </>
  )
}

/**
 * The copy row: the copy mark turns into a check for a moment after a copy, or red when the copy
 * failed. The live region sits beside the button, not in its name, so VoiceOver announces the
 * result. The wrapper takes the group's divider.
 */
function CopyRow({
  copy: text,
  className,
  disabled,
  ...base
}: ListRowBase & { copy: string }): React.JSX.Element {
  const { copied, failed, copy } = useCopy()
  return (
    <div data-slot="list-row-copy" className="flex flex-col">
      <button
        type="button"
        disabled={disabled}
        onClick={() => copy(text)}
        className={cn(ROW, PRESSABLE, base.detail ? 'min-h-[54px]' : 'min-h-[46px]', className)}
      >
        <RowContent {...base} />
        <span className="sr-only">, copy</span>
        {copied !== null ? (
          <Check aria-hidden className={cn(MARK, 'text-feature-voice-text')} />
        ) : (
          <Copy aria-hidden className={cn(MARK, failed && 'text-feature-danger-text')} />
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied !== null ? 'Copied' : failed ? 'Could not copy' : ''}
      </span>
    </div>
  )
}

/**
 * Mobile / List Row (kit o6y0O): padding 0/14/0/12, tile 32 with icon 17, label 15/700, detail
 * 12.5/500, value 13.5/600. 54 high with a detail, 46 for one line. Static, a button (chevron), an
 * external link (arrow), a switch or a copy row (see `ListRowMode`).
 */
export function ListRow(props: ListRowProps): React.JSX.Element {
  const labelId = useId()
  const detailId = useId()
  const { onClick, href, toggle, copy, trailing, chevron, ...base } = props
  const { className, disabled, tone } = base
  const height = base.detail ? 'min-h-[54px]' : 'min-h-[46px]'

  if (copy !== undefined) return <CopyRow {...base} copy={copy} />

  if (onClick) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cn(ROW, PRESSABLE, height, className)}
      >
        <RowContent {...base} />
        {(chevron ?? tone !== 'danger') && <ChevronRight aria-hidden className={MARK} />}
      </button>
    )
  }

  if (href !== undefined) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-disabled={disabled || undefined}
        className={cn(
          ROW,
          PRESSABLE,
          height,
          disabled && 'pointer-events-none opacity-50',
          className
        )}
      >
        <RowContent {...base} />
        <ArrowUpRight aria-hidden className={MARK} />
      </a>
    )
  }

  if (toggle) {
    return (
      <label
        className={cn(
          ROW,
          height,
          disabled ? 'opacity-50' : 'active:bg-surface-hover cursor-pointer',
          className
        )}
      >
        <RowContent {...base} labelId={labelId} detailId={detailId} />
        <Switch
          size="touch"
          checked={toggle.checked}
          onCheckedChange={toggle.onCheckedChange}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={base.detail ? detailId : undefined}
        />
      </label>
    )
  }

  return (
    <div className={cn(ROW, height, className)}>
      <RowContent {...base} />
      {trailing}
    </div>
  )
}
