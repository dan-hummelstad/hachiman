import { cn } from '@/lib/utils'
import { navigate } from '@/stores/navStore'

/**
 * A 31px sidebar row: quiet tertiary text, the hover fill, and for the selected row a neutral
 * fill with primary text (the `here` mark is the bar the row draws). Touch rows are 38 high with
 * a tint of `here` when selected.
 */
export function sidebarRowClass(selected: boolean, className?: string): string {
  return cn(
    'rounded-row mobile:rounded-option relative flex h-[31px] w-full items-center gap-2 pr-2 pl-2.5 text-left text-[13px]',
    selected
      ? 'bg-surface-selected text-text-primary mobile:bg-here-tint font-semibold'
      : 'text-text-tertiary hover:bg-surface-hover',
    className
  )
}

/** A channel row on the mobile layout (the drawer, M3): 38 high, text 13.5. */
export const CHANNEL_ROW_TOUCH = 'mobile:h-[38px] mobile:text-[13.5px]'

/** "New message": the DM home (the People view), where a conversation starts. */
export const openDmHome = (): void => navigate({ kind: 'dmHome' })
