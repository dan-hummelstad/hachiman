import { useLayout } from '@/hooks/use-layout'
import { accountTabs, moved, usePrefsStore } from '@/stores/prefsStore'
import { useCurrentView, type View } from '@/stores/navStore'

/**
 * The pinned tabs (N1) of the signed-in account. They live in its account preferences
 * (prefsStore), so they persist per account with the other preferences.
 */

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

const legacyKey = (userId: string): string => `hachiman:tabs:${userId}`

/**
 * Once per account: the tabs that older builds kept under `hachiman:tabs:<userId>` move into the
 * account preferences, then the key goes. Call it after setAccountId.
 */
export function migrateLegacyTabs(userId: string): void {
  try {
    const raw = localStorage.getItem(legacyKey(userId))
    if (raw === null) return
    const parsed: unknown = JSON.parse(raw)
    const legacy = Array.isArray(parsed) ? parsed.filter(isTabTarget) : []
    if (usePrefsStore.getState().accountId === userId)
      usePrefsStore.getState().updateTabs((tabs) => (tabs.length > 0 ? tabs : legacy))
    localStorage.removeItem(legacyKey(userId))
  } catch {
    // No storage (private window, tests) or bad JSON: nothing to move.
  }
}

function isTabTarget(v: unknown): v is TabTarget {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  return (
    (t.kind === 'channel' || t.kind === 'page' || t.kind === 'dm') &&
    typeof t.id === 'string' &&
    (t.guildId === null || typeof t.guildId === 'string') &&
    (t.pageId === undefined || typeof t.pageId === 'string')
  )
}

export const sameTarget = (a: TabTarget, b: TabTarget): boolean =>
  a.kind === b.kind && a.id === b.id && (a.pageId ?? null) === (b.pageId ?? null)

const updateTabs = (f: (tabs: TabTarget[]) => TabTarget[]): void =>
  usePrefsStore.getState().updateTabs(f)

/** The tabs of the signed-in account, outside React. */
export const currentTabs = (): TabTarget[] => accountTabs(usePrefsStore.getState())

/** Drops the tabs whose target is gone (channel deleted, guild left, no VIEW_CHANNEL, page deleted). */
export function pruneTabs(exists: (t: TabTarget) => boolean): void {
  updateTabs((tabs) => {
    const kept = tabs.filter(exists)
    return kept.length === tabs.length ? tabs : kept
  })
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
 * its pages channel. `pageTabOfChannel` (the mobile layout, where a pages channel opens on its
 * chat): a channel view with no tab of its own lights the first pinned page tab of the channel.
 */
export function activeIndex(
  tabs: readonly TabTarget[],
  view: View,
  { pageTabOfChannel = false }: { pageTabOfChannel?: boolean } = {}
): number {
  const target = targetOf(view)
  if (!target) return -1
  const exact = tabs.findIndex((t) => sameTarget(t, target))
  if (exact >= 0) return exact
  if (target.kind === 'page')
    return tabs.findIndex((t) => t.kind === 'channel' && t.id === target.id)
  if (target.kind === 'channel' && pageTabOfChannel)
    return tabs.findIndex((t) => t.kind === 'page' && t.id === target.id)
  return -1
}

export const isPinned = (tabs: readonly TabTarget[], target: TabTarget): boolean =>
  tabs.some((t) => sameTarget(t, target))

export const pinTab = (target: TabTarget, at?: number): void =>
  updateTabs((tabs) => {
    if (tabs.some((t) => sameTarget(t, target))) return tabs
    const next = [...tabs]
    next.splice(at ?? next.length, 0, target)
    return next
  })
export const unpinTab = (target: TabTarget): void =>
  updateTabs((tabs) =>
    tabs.some((t) => sameTarget(t, target)) ? tabs.filter((t) => !sameTarget(t, target)) : tabs
  )
export const moveTab = (from: number, to: number): void =>
  updateTabs((tabs) => (from === to ? tabs : moved(tabs, from, to)))

export const useTabs = (): TabTarget[] => usePrefsStore(accountTabs)

/** The index of the lit tab, or -1. */
export function useActiveTabIndex(): number {
  const tabs = useTabs()
  const view = useCurrentView()
  const pageTabOfChannel = useLayout() === 'mobile'
  return activeIndex(tabs, view, { pageTabOfChannel })
}

/** Whether `target` is pinned (false for null). */
export const useIsPinned = (target: TabTarget | null): boolean =>
  usePrefsStore((s) => target !== null && isPinned(accountTabs(s), target))
