import { useEffect, useRef, useState } from 'react'
import { PanelLeftClose } from 'lucide-react'
import { InboxButton } from '@/components/inbox/inbox-button'
import { useInboxScreenOpen } from '@/components/inbox/inbox-screen'
import { Drawer } from '@/components/mobile/drawer'
import {
  closeDrawer,
  hasRightDrawer,
  resetDrawers,
  toggleDrawer,
  useDrawerState
} from '@/components/mobile/drawer-state'
import { MobileChatPane } from '@/components/mobile/mobile-chat-pane'
import { MobileTabStrip } from '@/components/mobile/mobile-tab-strip'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import { PageScreen } from '@/components/mobile/page-screen'
import { SettingsHost } from '@/components/mobile/settings-host'
import { useSwipe } from '@/components/mobile/use-swipe'
import { RightColumn } from '@/components/people/right-column'
import { MeButton } from '@/components/shell/me-button'
import { QuickSwitcher, SwitcherField } from '@/components/shell/quick-switcher'
import { WALLPAPER, useDefaultChannel } from '@/components/shell/shell'
import { Sidebar } from '@/components/shell/sidebar'
import { SidebarRows } from '@/components/shell/sidebar-rows'
import { useSwitcher } from '@/components/shell/switcher-state'
import { useGuildTint } from '@/components/shell/use-guild-tint'
import { DmSpace } from '@/components/sidebar/dm-space'
import { GuildChannelList } from '@/components/sidebar/guild-channels'
import { VoiceDock } from '@/components/voice-connected-panel'
import { IncomingCall } from '@/components/voice/incoming-call'
import { useAppShortcuts } from '@/hooks/use-app-shortcuts'
import { useNativeAppearance, useResolvedTheme } from '@/hooks/use-native-appearance'
import { isAutoSelect } from '@/lib/auto-select'
import { drawerAfter, type DrawerEvent, type DrawerSide } from '@/lib/mobile-drawer'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { OVER_LEFT_DRAWER, useDialogStore } from '@/stores/dialogStore'
import { useDocsStore } from '@/stores/docsStore'
import {
  currentView,
  sameView,
  useCurrentView,
  useNavStore,
  useSelectedChannelId,
  useSelectedGuildId
} from '@/stores/navStore'

/** The time a closed right drawer keeps its column: the slide (250) and a margin. */
const UNMOUNT_MS = 400

/**
 * The browser pans vertical scrollers natively; a sideways move reaches the swipe hook. Sideways
 * scrollers (tabs, code blocks, image rows) keep their own pan.
 */
const TOUCH =
  'touch-pan-y [&_.overflow-y-auto]:touch-pan-y [&_[data-radix-scroll-area-viewport]]:touch-pan-y'

/** The sidebar keybind. As the edge swipe, it opens no drawer over a pushed screen (§2.4). */
const toggleLeft = (): void => {
  const { pushed, localPushed } = useDrawerState.getState()
  if (!pushed && localPushed === 0) toggleDrawer('left')
}

/**
 * Closes a drawer on a navigation, a dialog or the quick switcher (`lib/mobile-drawer.ts`). A
 * guild switch keeps the left drawer open on the new guild's channels, and so does a dialog that a
 * drawer control opens (`OVER_LEFT_DRAWER`, M44: the "+" stays lit under the dim).
 */
function useDrawerCloseRule(): void {
  useEffect(() => {
    const apply = (event: DrawerEvent): void => {
      const open = useDrawerState.getState().open
      const next = drawerAfter(open, event)
      if (next !== open) useDrawerState.setState({ open: next })
    }
    let from = currentView()
    const onView = (): void => {
      const to = currentView()
      if (sameView(from, to)) return
      const prev = from
      from = to
      apply({ kind: 'navigate', from: prev, to, auto: isAutoSelect() })
    }
    const offs = [
      useNavStore.subscribe(onView),
      useDocsStore.subscribe(onView),
      useDialogStore.subscribe((s, prev) => {
        if (s.dialog !== null && s.dialog !== prev.dialog)
          apply({ kind: 'dialog', overLeft: OVER_LEFT_DRAWER.has(s.dialog.kind) })
      }),
      useSwitcher.subscribe((s, prev) => {
        if (s.mode !== null && prev.mode === null) apply({ kind: 'dialog' })
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])
}

/**
 * A drawer wired to `useDrawerState`: it alone re-renders while a finger drags it, and the
 * children (made by the shell) do not. `lazy`: the children mount at the first open or drag, and
 * unmount after the drawer has slid shut.
 */
function DrawerHost({
  side,
  lazy = false,
  label,
  closeLabel,
  className,
  children
}: {
  side: DrawerSide
  lazy?: boolean
  label: string
  closeLabel: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const open = useDrawerState((s) => s.open === side)
  const progress = useDrawerState((s) => (s.drag?.side === side ? s.drag.share : null))
  const wanted = open || progress !== null
  const [mounted, setMounted] = useState(!lazy)
  if (wanted && !mounted) setMounted(true)
  useEffect(() => {
    if (!lazy || wanted || !mounted) return
    const t = setTimeout(() => setMounted(false), UNMOUNT_MS)
    return () => clearTimeout(t)
  }, [lazy, wanted, mounted])

  return (
    <Drawer
      side={side}
      open={open}
      progress={progress}
      onClose={closeDrawer}
      label={label}
      closeLabel={closeLabel}
      className={className}
    >
      {mounted && children}
    </Drawer>
  )
}

/**
 * The signed-in layout on a phone (docs/ios-mobile-ui-spec.md §2.3, rule 01 "Chat is the screen").
 * On the tinted window: the safe top, the tab strip (48), then the chat card. The sidebar comes in
 * as a drawer from the left (rule 02) and the right column from the right (rule 03); settings and
 * a page push in from the right (rule 06). The chat card stays mounted under all of them, so the
 * open tab and the scroll position stay. While a drawer is open or a screen is pushed, the chat
 * is inert (VoiceOver and Tab stay on top).
 *
 * The voice dock sits in the left drawer foot; the drawer is always mounted, so the dock never
 * remounts. The right drawer mounts at its first open or drag: a mounted column re-renders on
 * every presence event.
 */
export function MobileShell(): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const selectedGuildId = useSelectedGuildId()
  const selectedChannelId = useSelectedChannelId()
  const selectedChannel = useChannelStore((s) =>
    selectedChannelId ? s.channels.get(selectedChannelId) : undefined
  )
  const tint = useGuildTint(selectedGuildId)
  const drawerOpen = useDrawerState((s) => s.open !== null)
  const viewKind = useCurrentView().kind
  const pushed = viewKind === 'settings' || viewKind === 'page'
  // A screen pushed inside the chat card (the DM home's People list): Back on the edge, and the
  // tab strip goes inert. The chat card holds the screen, so it cannot go inert itself.
  const localPushed = useDrawerState((s) => s.localPushed > 0)
  // The inbox screen (M67) is portaled into this root, outside the main column.
  const inboxOpen = useInboxScreenOpen()
  const hasRight = selectedChannel !== undefined && hasRightDrawer(selectedChannel)
  // The right drawer shows a DM profile, the page tree of a pages channel (M42), or the members.
  const rightLabel =
    selectedChannel?.guildId === null
      ? 'Profile'
      : selectedChannel?.type === 'pages'
        ? 'Pages'
        : 'Members'

  useNativeAppearance(tint.window[useResolvedTheme()])
  useDefaultChannel(selectedGuildId, selectedChannel !== undefined)
  useAppShortcuts(toggleLeft)
  useDrawerCloseRule()
  useSwipe(root, { pushed: pushed || localPushed, hasRight })

  useEffect(() => {
    useDrawerState.setState({ pushed })
  }, [pushed])
  useEffect(() => resetDrawers, [])

  return (
    <div
      ref={root}
      style={tint.vars as React.CSSProperties}
      className={cn(
        'fixed inset-x-0 top-0 flex h-(--app-height,100dvh) flex-col overflow-clip pt-(--safe-top)',
        WALLPAPER,
        TOUCH
      )}
    >
      <div inert={drawerOpen || pushed || inboxOpen} className="flex min-h-0 flex-1 flex-col">
        <div className="contents" inert={localPushed}>
          <MobileTabStrip />
        </div>
        <div
          data-swipe-area="chat"
          className="bg-surface-content border-line-hairline flex min-h-0 flex-1 flex-col border-t"
        >
          <MobileChatPane />
        </div>
      </div>
      <DrawerHost side="left" label="Sidebar" closeLabel="Close sidebar" className={WALLPAPER}>
        <Sidebar
          className="w-full px-3 pt-[calc(var(--safe-top)+2px)] pb-(--safe-bottom)"
          controls={
            <>
              <button
                type="button"
                aria-label="Close sidebar"
                onClick={closeDrawer}
                className={cn(
                  KIT_ICON_BUTTON,
                  'bg-fill-control-strong text-text-secondary active:bg-surface-selected'
                )}
              >
                <PanelLeftClose />
              </button>
              <div className="ml-auto flex items-center gap-0.5">
                <InboxButton className="size-9" />
                <MeButton />
              </div>
            </>
          }
          top={
            <>
              <SwitcherField />
              <SidebarRows />
            </>
          }
          middle={selectedGuildId ? <GuildChannelList guildId={selectedGuildId} /> : <DmSpace />}
          foot={<VoiceDock />}
        />
      </DrawerHost>
      <DrawerHost
        side="right"
        lazy
        label={rightLabel}
        closeLabel={`Close ${rightLabel.toLowerCase()}`}
        className="bg-surface-panel pt-(--safe-top) pb-(--safe-bottom)"
      >
        {selectedChannel && hasRight && <RightColumn channel={selectedChannel} variant="drawer" />}
      </DrawerHost>
      <SettingsHost />
      <PageScreen />
      <QuickSwitcher />
      <IncomingCall />
    </div>
  )
}
