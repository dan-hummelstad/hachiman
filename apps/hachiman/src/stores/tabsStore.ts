import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { moved } from '@/stores/prefsStore'
import { useCurrentView, type View } from '@/stores/navStore'

/**
 * A pinned tab (N1). `id` is the channel id (a pages channel for 'page', with `pageId`). Voice and
 * pages channels are 'channel' tabs: the type comes from channelStore.
 */
export interface TabTarget {
  kind: 'channel' | 'page' | 'dm'
  id: string
  guildId: string | null
  pageId?: string
}

interface TabsState {
  /** The account whose tabs these are; null = signed out (no tabs). */
  userId: string | null
  tabs: TabTarget[]
  pin: (target: TabTarget, at?: number) => void
  unpin: (target: TabTarget) => void
  move: (from: number, to: number) => void
}

const storageKey = (userId: string): string => `hachiman:tabs:${userId}`

function readTabs(userId: string): TabTarget[] {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as TabTarget[]) : []
  } catch {
    return []
  }
}

function writeTabs(userId: string | null, tabs: TabTarget[]): void {
  if (userId === null) return
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(tabs))
  } catch {
    // No storage (private window, tests): the tabs live for this session only.
  }
}

export const sameTarget = (a: TabTarget, b: TabTarget): boolean =>
  a.kind === b.kind && a.id === b.id && (a.pageId ?? null) === (b.pageId ?? null)

export const useTabsStore = create<TabsState>()(
  devtools((set) => {
    const update = (f: (tabs: TabTarget[]) => TabTarget[]): void =>
      set((s) => {
        const tabs = f(s.tabs)
        if (tabs === s.tabs) return s
        writeTabs(s.userId, tabs)
        return { tabs }
      })
    return {
      userId: null,
      tabs: [],
      pin: (target, at) =>
        update((tabs) => {
          if (tabs.some((t) => sameTarget(t, target))) return tabs
          const next = [...tabs]
          next.splice(at ?? next.length, 0, target)
          return next
        }),
      unpin: (target) =>
        update((tabs) =>
          tabs.some((t) => sameTarget(t, target))
            ? tabs.filter((t) => !sameTarget(t, target))
            : tabs
        ),
      move: (from, to) => update((tabs) => (from === to ? tabs : moved(tabs, from, to)))
    }
  })
)

/** Sign-in (or a switch of account): load that account's tabs. null = sign-out. */
export function loadTabs(userId: string | null): void {
  if (useTabsStore.getState().userId === userId) return
  useTabsStore.setState({ userId, tabs: userId === null ? [] : readTabs(userId) })
}

/** Drops the tabs whose target is gone (channel deleted, guild left, no VIEW_CHANNEL, page deleted). */
export function pruneTabs(exists: (t: TabTarget) => boolean): void {
  const { tabs, userId } = useTabsStore.getState()
  const kept = tabs.filter(exists)
  if (kept.length === tabs.length) return
  writeTabs(userId, kept)
  useTabsStore.setState({ tabs: kept })
}

/** The tab target of a view; null for views that cannot be pinned (DM home, guild, settings). */
export function targetOf(view: View): TabTarget | null {
  switch (view.kind) {
    case 'channel':
      return { kind: 'channel', id: view.channelId, guildId: view.guildId }
    case 'page':
      return { kind: 'page', id: view.channelId, guildId: view.guildId, pageId: view.pageId }
    case 'dm':
      return { kind: 'dm', id: view.channelId, guildId: null }
    default:
      return null
  }
}

/** The view that opening `t` shows. */
export function viewOfTarget(t: TabTarget): View {
  if (t.kind === 'dm') return { kind: 'dm', channelId: t.id }
  const guildId = t.guildId ?? ''
  return t.kind === 'page' && t.pageId
    ? { kind: 'page', guildId, channelId: t.id, pageId: t.pageId }
    : { kind: 'channel', guildId, channelId: t.id }
}

/**
 * The index of the lit tab for `view`, or -1. A page view lights its page tab, else the tab of
 * its pages channel.
 */
export function activeIndex(tabs: readonly TabTarget[], view: View): number {
  const target = targetOf(view)
  if (!target) return -1
  const exact = tabs.findIndex((t) => sameTarget(t, target))
  if (exact >= 0 || target.kind !== 'page') return exact
  return tabs.findIndex((t) => t.kind === 'channel' && t.id === target.id)
}

export const isPinned = (tabs: readonly TabTarget[], target: TabTarget): boolean =>
  tabs.some((t) => sameTarget(t, target))

export const pinTab = (target: TabTarget, at?: number): void =>
  useTabsStore.getState().pin(target, at)
export const unpinTab = (target: TabTarget): void => useTabsStore.getState().unpin(target)
export const moveTab = (from: number, to: number): void => useTabsStore.getState().move(from, to)

export const useTabs = (): TabTarget[] => useTabsStore((s) => s.tabs)

/** The index of the lit tab, or -1. */
export function useActiveTabIndex(): number {
  const tabs = useTabs()
  const view = useCurrentView()
  return activeIndex(tabs, view)
}

/** Whether `target` is pinned (false for null). */
export const useIsPinned = (target: TabTarget | null): boolean =>
  useTabsStore((s) => target !== null && isPinned(s.tabs, target))
