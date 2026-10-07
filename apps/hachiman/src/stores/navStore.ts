import type {} from '@redux-devtools/extension'
import { useMemo } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { devtools, persist } from 'zustand/middleware'
import { useDocsStore } from '@/stores/docsStore'

/** `guildKey` for the DM home (and the `channelByGuild` key for its open DM). */
export const DM_HOME = '@me'

/** Whose settings a settings view shows. */
export type SettingsTarget =
  { kind: 'user' } | { kind: 'guild'; guildId: string } | { kind: 'channel'; channelId: string }

/** A settings page: the target and its section (null = the first visible one). */
export interface SettingsView {
  target: SettingsTarget
  section: string | null
}

/** What the shell shows (N2). History entries and pinned tabs (N1) are views. */
export type View =
  | { kind: 'dmHome' }
  | { kind: 'dm'; channelId: string }
  | { kind: 'guild'; guildId: string }
  | { kind: 'channel'; guildId: string; channelId: string }
  | { kind: 'page'; guildId: string; channelId: string; pageId: string }
  | { kind: 'settings'; settings: SettingsView }

/** At most this many entries in `past` and in `future`. */
export const HISTORY_CAP = 50

/** Where the user is looking. Persisted; independent of the voice channel. */
interface NavState {
  /** Selected guild id, or DM_HOME. */
  guildKey: string
  /** guildKey → channel being viewed there. Absent = none (DM home: the People pane). */
  channelByGuild: Record<string, string>
  /** The settings page that the shell shows in place of the view (sidebar + content card), or null. */
  settings: SettingsView | null
  /** Back history, oldest first. In memory only. */
  past: View[]
  /** Forward history, the next one last. In memory only. */
  future: View[]
  selectGuild: (guildKey: string) => void
  /** Select a channel in `guildKey` (default: the current one). null clears that guild's selection. */
  selectChannel: (channelId: string | null, guildKey?: string) => void
  /** Switch to `guildKey` and view `channelId` there. */
  openChannel: (guildKey: string, channelId: string) => void
  /** Drop a guild's remembered channel; leave it for the DM home if it's the selected one. */
  forgetGuild: (guildId: string) => void
  openSettings: (target: SettingsTarget, section?: string | null) => void
  setSettingsSection: (section: string) => void
  closeSettings: () => void
}

export const useNavStore = create<NavState>()(
  devtools(
    persist(
      (set) => ({
        guildKey: DM_HOME,
        channelByGuild: {},
        settings: null,
        past: [],
        future: [],
        selectGuild: (guildKey) => set({ guildKey, settings: null }),
        selectChannel: (channelId, guildKey) =>
          set((s) => {
            const key = guildKey ?? s.guildKey
            const next = { ...s.channelByGuild }
            if (channelId === null) delete next[key]
            else next[key] = channelId
            return { channelByGuild: next, settings: null }
          }),
        openChannel: (guildKey, channelId) =>
          set((s) => ({
            guildKey,
            channelByGuild: { ...s.channelByGuild, [guildKey]: channelId },
            settings: null
          })),
        forgetGuild: (guildId) =>
          set((s) => {
            const channelByGuild = { ...s.channelByGuild }
            delete channelByGuild[guildId]
            const settings =
              s.settings?.target.kind === 'guild' && s.settings.target.guildId === guildId
                ? null
                : s.settings
            return {
              channelByGuild,
              settings,
              guildKey: s.guildKey === guildId ? DM_HOME : s.guildKey
            }
          }),
        openSettings: (target, section = null) => set({ settings: { target, section } }),
        setSettingsSection: (section) =>
          set((s) => (s.settings ? { settings: { ...s.settings, section } } : s)),
        closeSettings: () => set({ settings: null })
      }),
      {
        name: 'hachiman-nav-storage',
        partialize: (s) => ({ guildKey: s.guildKey, channelByGuild: s.channelByGuild })
      }
    )
  )
)

type NavData = Pick<NavState, 'guildKey' | 'channelByGuild' | 'settings'>

/** The view of a nav state; `openPage` gives the open page of a pages channel. */
export function viewOf(nav: NavData, openPage: (channelId: string) => string | undefined): View {
  if (nav.settings) return { kind: 'settings', settings: nav.settings }
  const channelId = nav.channelByGuild[nav.guildKey]
  if (nav.guildKey === DM_HOME) return channelId ? { kind: 'dm', channelId } : { kind: 'dmHome' }
  const guildId = nav.guildKey
  if (!channelId) return { kind: 'guild', guildId }
  const pageId = openPage(channelId)
  return pageId
    ? { kind: 'page', guildId, channelId, pageId }
    : { kind: 'channel', guildId, channelId }
}

export function sameView(a: View, b: View): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The view the shell shows now. */
export function currentView(): View {
  const pages = useDocsStore.getState().openPageByChannel
  return viewOf(useNavStore.getState(), (id) => pages.get(id))
}

/** History after a navigation from `from`: `from` goes on `past` (capped), `future` clears. */
export function pushHistory(past: View[], from: View): Pick<NavState, 'past' | 'future'> {
  const last = past[past.length - 1]
  const next = last && sameView(last, from) ? past : [...past, from]
  return { past: next.slice(-HISTORY_CAP), future: [] }
}

/**
 * History after leaving a settings view for `to`: settings are not history entries once left, so
 * Back returns to the view before them. The settings entries on top of `past` go, and so does the
 * view settings opened from when `to` is that view.
 */
export function leaveSettings(past: View[], to: View): Pick<NavState, 'past' | 'future'> {
  const next = [...past]
  while (next.length > 0 && next[next.length - 1].kind === 'settings') next.pop()
  const last = next[next.length - 1]
  if (last && sameView(last, to)) next.pop()
  return { past: next, future: [] }
}

/**
 * One step back (`dir` 'back') or forward. Entries whose target `exists` says is gone are dropped.
 * Null when no entry is left on that side.
 */
export function stepHistory(
  h: Pick<NavState, 'past' | 'future'>,
  current: View,
  dir: 'back' | 'forward',
  exists: (v: View) => boolean
): { view: View; past: View[]; future: View[] } | null {
  const from = dir === 'back' ? [...h.past] : [...h.future]
  let target: View | undefined
  while ((target = from.pop()) !== undefined) {
    if (exists(target) && !sameView(target, current)) break
  }
  if (!target) return null
  const to = dir === 'back' ? h.future : h.past
  const other = [...to, current].slice(-HISTORY_CAP)
  return dir === 'back'
    ? { view: target, past: from, future: other }
    : { view: target, past: other, future: from }
}

/** While applying a history step: the store changes are not navigations. */
let applying = false
let lastView: View = currentView()

/** Show `view`: the one place that turns a view into store changes. */
function applyView(view: View): void {
  const nav = useNavStore.getState()
  switch (view.kind) {
    case 'dmHome':
      nav.selectChannel(null, DM_HOME)
      return nav.selectGuild(DM_HOME)
    case 'dm':
      return nav.openChannel(DM_HOME, view.channelId)
    case 'guild':
      nav.selectChannel(null, view.guildId)
      return nav.selectGuild(view.guildId)
    case 'channel':
      useDocsStore.getState().setOpenPage(view.channelId, null)
      return nav.openChannel(view.guildId, view.channelId)
    case 'page':
      useDocsStore.getState().setOpenPage(view.channelId, view.pageId)
      return nav.openChannel(view.guildId, view.channelId)
    case 'settings':
      return nav.openSettings(view.settings.target, view.settings.section)
  }
}

/** Every change of the shown view (from any entry point) is a navigation. */
function record(): void {
  if (applying) return
  const view = currentView()
  if (sameView(view, lastView)) return
  const from = lastView
  lastView = view
  useNavStore.setState((s) =>
    from.kind === 'settings' && view.kind !== 'settings'
      ? leaveSettings(s.past, view)
      : pushHistory(s.past, from)
  )
}
useNavStore.subscribe(record)
useDocsStore.subscribe(record)

/** Applies `view` as one change: the store updates in between are not navigations. */
function applyQuietly(view: View): void {
  applying = true
  try {
    applyView(view)
  } finally {
    applying = false
  }
  lastView = currentView()
}

/** Go to `view` as one navigation (the view before it goes on the history). */
export function navigate(view: View): void {
  const from = currentView()
  applyQuietly(view)
  if (sameView(from, lastView)) return
  const to = lastView
  useNavStore.setState((s) =>
    from.kind === 'settings' && to.kind !== 'settings'
      ? leaveSettings(s.past, to)
      : pushHistory(s.past, from)
  )
}

function step(dir: 'back' | 'forward', exists: (v: View) => boolean): boolean {
  const s = useNavStore.getState()
  const current = currentView()
  const next = stepHistory(s, current, dir, exists)
  if (!next) return false
  applyQuietly(next.view)
  useNavStore.setState({ past: next.past, future: next.future })
  return true
}

/** One step back. `exists` skips targets that are gone. False when there is nothing to go to. */
export const back = (exists: (v: View) => boolean = () => true): boolean => step('back', exists)
export const forward = (exists: (v: View) => boolean = () => true): boolean =>
  step('forward', exists)

/** Sign-out: the history belongs to the session that ended. */
export function clearHistory(): void {
  lastView = currentView()
  useNavStore.setState({ past: [], future: [] })
}

/** The selected guild id; null = the DM home. */
export const useSelectedGuildId = (): string | null =>
  useNavStore((s) => (s.guildKey === DM_HOME ? null : s.guildKey))

/** The channel being viewed in the selected guild (or DM home), if any. */
export const useSelectedChannelId = (): string | null =>
  useNavStore((s) => s.channelByGuild[s.guildKey] ?? null)

/** The view the shell shows (stable while it does not change). */
export function useCurrentView(): View {
  const { guildKey, channelByGuild, settings } = useNavStore(
    useShallow((s) => ({
      guildKey: s.guildKey,
      channelByGuild: s.channelByGuild,
      settings: s.settings
    }))
  )
  const channelId = channelByGuild[guildKey]
  const pageId = useDocsStore((s) =>
    channelId !== undefined ? s.openPageByChannel.get(channelId) : undefined
  )
  return useMemo(
    () => viewOf({ guildKey, channelByGuild, settings }, () => pageId),
    [guildKey, channelByGuild, settings, pageId]
  )
}

export const useCanGoBack = (): boolean => useNavStore((s) => s.past.length > 0)
export const useCanGoForward = (): boolean => useNavStore((s) => s.future.length > 0)
export const useSettingsView = (): SettingsView | null => useNavStore((s) => s.settings)

/** The open channel, outside React. */
export const selectedChannelId = (): string | null => {
  const s = useNavStore.getState()
  return s.channelByGuild[s.guildKey] ?? null
}
export const selectGuild = (guildKey: string): void => useNavStore.getState().selectGuild(guildKey)
export const selectChannel = (channelId: string | null, guildKey?: string): void =>
  useNavStore.getState().selectChannel(channelId, guildKey)
export const openChannel = (guildKey: string, channelId: string): void =>
  useNavStore.getState().openChannel(guildKey, channelId)
export const forgetGuild = (guildId: string): void => useNavStore.getState().forgetGuild(guildId)
export const openSettings = (target: SettingsTarget, section?: string | null): void =>
  useNavStore.getState().openSettings(target, section)
export const setSettingsSection = (section: string): void =>
  useNavStore.getState().setSettingsSection(section)
export const closeSettings = (): void => useNavStore.getState().closeSettings()
