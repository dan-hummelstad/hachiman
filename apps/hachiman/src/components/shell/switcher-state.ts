import { useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { create } from 'zustand'
import { Permissions, has } from '@hachiman/client'
import { layoutNow } from '@/hooks/use-layout'
import { dmName } from '@/lib/model'
import {
  ANY_RESULT,
  inFilter,
  initialFilterKind,
  keyOfView,
  rankItems,
  recentKeys,
  type SwitchFilter,
  type SwitchItem
} from '@/lib/quick-switcher'
import { dmChannelWith, hachiman } from '@/services/hachiman'
import { useChannelStore } from '@/stores/channelStore'
import { useDocsStore } from '@/stores/docsStore'
import { useGuildStore } from '@/stores/guildStore'
import { currentView, navigate, useNavStore, type View } from '@/stores/navStore'
import { isPinned, pinTab, targetOf, type TabTarget } from '@/stores/tabsStore'
import { useUserStore } from '@/stores/userStore'

/** 'open': Enter opens, ⌘Enter pins. 'pin' (the tab bar's "+"): Enter pins. */
export type SwitcherMode = 'open' | 'pin'

interface SwitcherState {
  /** null = closed. */
  mode: SwitcherMode | null
  /** The chips of the mobile search screen (M66). The desktop switcher lists everything. */
  filter: SwitchFilter
}

/** The quick switcher (N5), on a phone the search screen (M66). */
export const useSwitcher = create<SwitcherState>()(() => ({ mode: null, filter: ANY_RESULT }))

/**
 * Opens the switcher. On the mobile layout the search screen opens with its chips on People over
 * the DM home, else on All, in any guild. It renders inside this call (`flushSync`) and focuses its
 * field as it mounts, so the focus stays inside the opening tap and WKWebView raises the keyboard
 * (docs/ios-mobile-ui-spec.md §2.8). Call it from an event handler, never from render or an effect.
 */
export function openSwitcher(mode: SwitcherMode = 'open'): void {
  if (layoutNow() !== 'mobile') {
    useSwitcher.setState({ mode })
    return
  }
  const filter: SwitchFilter = { kind: initialFilterKind(currentView()), guildId: null }
  flushSync(() => useSwitcher.setState({ mode, filter }))
}

export const closeSwitcher = (): void => useSwitcher.setState({ mode: null })
export const isSwitcherOpen = (): boolean => useSwitcher.getState().mode !== null

/** Changes the chip or the "In:" guild of the search screen. */
export const setSwitcherFilter = (patch: Partial<SwitchFilter>): void =>
  useSwitcher.setState((s) => ({ filter: { ...s.filter, ...patch } }))

/** Every item the switcher can open: channels, voice, pages, DMs and people across all guilds. */
function collectItems(): SwitchItem[] {
  const { channels } = useChannelStore.getState()
  const { guilds, members } = useGuildStore.getState()
  const { pagesByChannel } = useDocsStore.getState()
  const myId = useUserStore.getState().me?.id
  const guildsOf = new Map<string, string[]>()
  for (const [guildId, byUser] of members) {
    for (const userId of byUser.keys()) {
      const list = guildsOf.get(userId)
      if (list) list.push(guildId)
      else guildsOf.set(userId, [guildId])
    }
  }
  const items: SwitchItem[] = []
  const dmWith = new Set<string>()
  for (const c of channels.values()) {
    if (c.guildId === null) {
      const other = c.type === 'dm' ? c.recipients?.[0] : undefined
      if (other) dmWith.add(other.id)
      items.push({
        key: `c:${c.id}`,
        kind: 'dm',
        name: dmName(c),
        guildId: null,
        guildName: null,
        channelId: c.id,
        ...(other && { userId: other.id, avatar: other.avatar }),
        guildIds: [...new Set(c.recipients?.flatMap((u) => guildsOf.get(u.id) ?? []))]
      })
      continue
    }
    if (c.type !== 'text' && c.type !== 'voice' && c.type !== 'pages') continue
    if (!has(hachiman.permissionsFor(c.id), Permissions.VIEW_CHANNEL)) continue
    const guildName = guilds.get(c.guildId)?.name ?? null
    items.push({
      key: `c:${c.id}`,
      kind: c.type,
      name: c.name ?? '',
      guildId: c.guildId,
      guildName,
      channelId: c.id
    })
    if (c.type !== 'pages') continue
    for (const p of pagesByChannel.get(c.id) ?? []) {
      if (p.titleState !== 'ok' || !p.title) continue
      items.push({
        key: `p:${p.id}`,
        kind: 'page',
        name: p.title,
        guildId: c.guildId,
        guildName,
        channelId: c.id,
        pageId: p.id
      })
    }
  }
  const people = new Set<string>()
  for (const byUser of members.values()) {
    for (const m of byUser.values()) {
      const id = m.user.id
      if (id === myId || dmWith.has(id) || people.has(id)) continue
      people.add(id)
      items.push({
        key: `u:${id}`,
        kind: 'person',
        name: m.user.username,
        guildId: null,
        guildName: null,
        channelId: null,
        userId: id,
        guildIds: guildsOf.get(id) ?? [],
        avatar: m.user.avatar
      })
    }
  }
  return items
}

/** The view an item opens; null for a person (the DM may not exist yet). */
function viewOfItem(it: SwitchItem): View | null {
  if (it.kind === 'person' || it.channelId === null) return null
  if (it.kind === 'dm') return { kind: 'dm', channelId: it.channelId }
  const guildId = it.guildId ?? ''
  return it.kind === 'page' && it.pageId
    ? { kind: 'page', guildId, channelId: it.channelId, pageId: it.pageId }
    : { kind: 'channel', guildId, channelId: it.channelId }
}

/** Opens (or with `pin`, pins) a result. A person opens (or reuses) the DM with them. */
export async function activateItem(it: SwitchItem, pin: boolean): Promise<void> {
  let view = viewOfItem(it)
  if (!view && it.userId) {
    view = { kind: 'dm', channelId: await dmChannelWith(it.userId) }
  }
  if (!view) return
  const target = targetOf(view)
  if (pin && target) pinTab(target)
  else navigate(view)
}

/** Whether the tab of a result is pinned (a person without a DM has no tab). */
export function isPinnedItem(tabs: readonly TabTarget[], it: SwitchItem): boolean {
  const view = viewOfItem(it)
  const target = view ? targetOf(view) : null
  return target !== null && isPinned(tabs, target)
}

export interface SwitcherResults {
  /** The ranked results (`rankItems`) that pass the filter. */
  results: SwitchItem[]
  /** The keys of the history, the most recent first: the current view, then the past. */
  recent: string[]
  /** The key of the current view, or null (the DM home, a guild, settings). */
  here: string | null
}

/**
 * The results of the switcher for `query` and `filter` (`limit` at most). The items and the
 * history are a snapshot from when the switcher opened: the lists are small and do not change
 * while it is open.
 */
export function useSwitcherResults(
  query: string,
  filter: SwitchFilter = ANY_RESULT,
  limit?: number
): SwitcherResults {
  const [items] = useState(collectItems)
  const [history] = useState(() => {
    const view = currentView()
    return { recent: recentKeys(useNavStore.getState().past, view), here: keyOfView(view) }
  })
  const results = useMemo(
    () =>
      rankItems(
        items.filter((it) => inFilter(it, filter)),
        query,
        history.recent,
        limit
      ),
    [items, filter, query, history, limit]
  )
  return { results, recent: history.recent, here: history.here }
}
