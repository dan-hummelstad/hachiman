import { PanelLeftOpen, Plus } from 'lucide-react'
import { toggleDrawer, useOpenDrawer } from '@/components/mobile/drawer-state'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import { openSwitcher } from '@/components/shell/switcher-state'
import { PinCurrent, Tabs } from '@/components/shell/tab-bar'
import { UnreadMark } from '@/components/ui/unread-mark'
import { cn } from '@/lib/utils'
import type { UnreadBadge } from '@/lib/notify'
import { useAllUnread } from '@/stores/unreadStore'

/** The tabs fade out over their last 24 px, where they scroll under the strip's buttons. */
const FADE = '[mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)]'

function toggleLabel(badge: UnreadBadge): string {
  if (badge.mentions > 0)
    return `Open sidebar, ${badge.mentions} ${badge.mentions === 1 ? 'mention' : 'mentions'}`
  return badge.unread ? 'Open sidebar, unread messages' : 'Open sidebar'
}

const toggleLeft = (): void => toggleDrawer('left')

/**
 * Mobile / Tab Strip (kit rJ9Dt, docs/ios-mobile-ui-spec.md §3): 48 high on the tinted window,
 * padding 10, gap 8. The sidebar toggle (36) with the unread badge of everything (17), a 1 × 20
 * divider, the pin glyph (15, no pressed fill), then a sideways scroller that runs to the screen
 * edge and fades over its last 24 px: the pinned tabs (34, gap 4, natural width) and "+" (pin a
 * tab) after the last one. The scroller is `data-swipe-ignore`: a sideways swipe there scrolls
 * the tabs and opens no drawer.
 */
export function MobileTabStrip(): React.JSX.Element {
  const open = useOpenDrawer() === 'left'
  const badge = useAllUnread()
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 pl-2.5">
      <button
        type="button"
        aria-label={toggleLabel(badge)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggleLeft}
        className={cn(
          KIT_ICON_BUTTON,
          'bg-surface-hover text-text-secondary active:bg-surface-selected relative'
        )}
      >
        <PanelLeftOpen />
        <UnreadMark
          badge={badge}
          size="corner"
          aria-hidden
          className={cn(badge.mentions > 0 && '-top-1 -right-1 h-[17px] min-w-[17px] text-[10px]')}
        />
      </button>
      <span aria-hidden className="bg-fill-control-strong h-5 w-px shrink-0" />
      <PinCurrent className="text-text-disabled aria-pressed:text-text-disabled -mx-1 size-9 shrink-0 aria-pressed:bg-transparent [&_svg]:size-[15px]" />
      <div
        data-swipe-ignore
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          FADE
        )}
      >
        <Tabs revealActive className="shrink-0 overflow-visible" />
        <button
          type="button"
          aria-label="Pin a tab"
          onClick={() => openSwitcher('pin')}
          className={cn(
            KIT_ICON_BUTTON,
            'border-accent-primary/50 bg-accent-tint text-accent-text active:border-accent-primary border'
          )}
        >
          <Plus className="size-4" />
        </button>
      </div>
    </div>
  )
}
