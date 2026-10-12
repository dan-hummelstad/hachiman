import { create } from 'zustand'
import type { Channel } from '@hachiman/client'
import type { DrawerSide } from '@/lib/mobile-drawer'

interface DrawerState {
  open: DrawerSide | null
  /** A finger drags a drawer: its side and its open share (0–1). */
  drag: { side: DrawerSide; share: number } | null
  /** A pushed screen (settings, a page) covers the chat. The MobileShell keeps it. */
  pushed: boolean
  /**
   * The local overlays over the chat that are not nav views: `ScreenStackProvider` screens (the
   * People list of the DM home), the search screen (M66) and the inbox screen (M67). The left
   * edge means Back there, the tab strip goes inert and the chat counts as covered.
   */
  localPushed: number
}

const initial = (): DrawerState => ({ open: null, drag: null, pushed: false, localPushed: 0 })

/**
 * The drawers of the mobile shell (docs/ios-mobile-ui-spec.md §2.4). In memory only: the
 * browser host shares `prefsStore.sidebar` with wide windows, so the drawers do not use it.
 */
export const useDrawerState = create<DrawerState>()(initial)

export const openDrawer = (side: DrawerSide): void => useDrawerState.setState({ open: side })
export const closeDrawer = (): void => useDrawerState.setState({ open: null })
export const toggleDrawer = (side: DrawerSide): void =>
  useDrawerState.setState((s) => ({ open: s.open === side ? null : side }))

/**
 * Whether the right drawer has something to show for `channel`: what `RightColumn` renders (the
 * column of a guild channel, the profile of a DM), not a group DM.
 */
export const hasRightDrawer = (channel: Channel): boolean =>
  channel.guildId !== null || (channel.type === 'dm' && channel.recipients?.[0] !== undefined)

/** The MobileShell unmounts (the window got wide): nothing stays open. */
export const resetDrawers = (): void => useDrawerState.setState(initial())

/** A local overlay (a `ScreenStackProvider` screen, search, inbox) shows (`1`) or goes (`-1`). */
export const countLocalPushed = (delta: 1 | -1): void =>
  useDrawerState.setState((s) => ({ localPushed: Math.max(0, s.localPushed + delta) }))

export const useOpenDrawer = (): DrawerSide | null => useDrawerState((s) => s.open)

/**
 * True while a drawer is open or a pushed screen shows: the chat is out of sight, so nothing in
 * it counts as read. Always false on the desktop layout.
 */
export const useChatCovered = (): boolean =>
  useDrawerState((s) => s.open !== null || s.pushed || s.localPushed > 0)
