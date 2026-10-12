import { selectableRowClass } from '@/components/ui/selectable-row'
import { cn } from '@/lib/utils'
import { navigate } from '@/stores/navStore'

/** A 30px sidebar row (padding 0/8/0/10): hover fill, and the selected fill with radius 8. */
export function sidebarRowClass(selected: boolean, className?: string): string {
  return selectableRowClass(
    selected,
    cn(
      'flex h-[30px] w-full items-center gap-2 pr-2 pl-2.5 text-left text-label',
      selected && 'font-bold',
      className
    )
  )
}

/** A channel row on the mobile layout (Arc sidebar in the drawer, M3): 38 high, text 15. */
export const CHANNEL_ROW_TOUCH = 'mobile:h-[38px] mobile:text-[15px]'

/** "New message": the DM home (the People view), where a conversation starts. */
export const openDmHome = (): void => navigate({ kind: 'dmHome' })
