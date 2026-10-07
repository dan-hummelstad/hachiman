import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import type { StreamQuality } from '@/lib/stream-quality'
import type { SoundEvent } from '@/lib/sounds'
import type { NotifyLevel, NotifyPrefs } from '@/lib/notify'
import type { TabTarget } from '@/stores/tabsStore'

export type MessageDisplay = 'cozy' | 'compact'
/** `system` follows the OS colour scheme. Applied to `<html>` by `ThemeProvider`. */
export type Theme = 'dark' | 'light' | 'system'
/** N3: the sidebar docked beside the content, or hidden and shown on hover. */
export type SidebarMode = 'docked' | 'undocked'

/** The preferences of one account on this device (N1, N6, N9). */
export interface AccountPrefs extends NotifyPrefs {
  /** DM channel ids, in tile order. */
  favouriteDms: string[]
  /** The pinned tabs (N1), in tab order. Absent in data stored before tabs moved here. */
  tabs?: TabTarget[]
}

const EMPTY_ACCOUNT: AccountPrefs = { favouriteDms: [], notify: {}, muted: [] }

/** Local, per-device UI preferences. Written by the user settings overlay. */
interface PrefsState {
  theme: Theme
  messageDisplay: MessageDisplay
  /** `MediaDeviceInfo.deviceId`; null = the system default. */
  inputDeviceId: string | null
  outputDeviceId: string | null
  /** Screen share capture and send quality. Applies to a live share too. */
  streamQuality: StreamQuality
  /** Notification and voice sounds (SoundService). */
  soundsEnabled: boolean
  /** 0..1 */
  soundVolume: number
  /** Sounds the user switched off one by one. Ignored while `soundsEnabled` is false. */
  disabledSounds: SoundEvent[]
  sidebar: SidebarMode
  /** userId → that account's preferences. */
  accounts: Record<string, AccountPrefs>
  /** The signed-in user id. Not persisted: services/hachiman.ts sets it. */
  accountId: string | null
  setTheme: (theme: Theme) => void
  setMessageDisplay: (messageDisplay: MessageDisplay) => void
  setInputDeviceId: (inputDeviceId: string | null) => void
  setOutputDeviceId: (outputDeviceId: string | null) => void
  setStreamQuality: (streamQuality: StreamQuality) => void
  setSoundsEnabled: (soundsEnabled: boolean) => void
  setSoundVolume: (soundVolume: number) => void
  setSoundEnabled: (event: SoundEvent, enabled: boolean) => void
  setSidebar: (sidebar: SidebarMode) => void
  setAccountId: (accountId: string | null) => void
  setFavouriteDm: (channelId: string, favourite: boolean) => void
  /** Reorders the favourite tiles. */
  moveFavouriteDm: (from: number, to: number) => void
  /** null clears the level of `id` (channel or guild): it follows its parent or the default. */
  setNotifyLevel: (id: string, level: NotifyLevel | null) => void
  setMuted: (id: string, muted: boolean) => void
  /** Replaces the tabs of the signed-in account with `f(tabs)`; returning `tabs` changes nothing. */
  updateTabs: (f: (tabs: TabTarget[]) => TabTarget[]) => void
}

const NO_TABS: TabTarget[] = []

/** The preferences of the signed-in account (a stable empty object when none). */
export const accountPrefs = (s: Pick<PrefsState, 'accounts' | 'accountId'>): AccountPrefs =>
  (s.accountId !== null ? s.accounts[s.accountId] : undefined) ?? EMPTY_ACCOUNT

export const usePrefsStore = create<PrefsState>()(
  devtools(
    persist(
      (set) => ({
        theme: 'dark',
        messageDisplay: 'cozy',
        inputDeviceId: null,
        outputDeviceId: null,
        streamQuality: { resolution: '1080p', fps: 30 },
        soundsEnabled: true,
        soundVolume: 0.7,
        disabledSounds: [],
        sidebar: 'docked',
        accounts: {},
        accountId: null,
        setTheme: (theme) => set({ theme }),
        setMessageDisplay: (messageDisplay) => set({ messageDisplay }),
        setInputDeviceId: (inputDeviceId) => set({ inputDeviceId }),
        setOutputDeviceId: (outputDeviceId) => set({ outputDeviceId }),
        setStreamQuality: (streamQuality) => set({ streamQuality }),
        setSoundsEnabled: (soundsEnabled) => set({ soundsEnabled }),
        setSoundVolume: (soundVolume) => set({ soundVolume }),
        setSoundEnabled: (event, enabled) =>
          set((s) => ({
            disabledSounds: enabled
              ? s.disabledSounds.filter((e) => e !== event)
              : [...new Set([...s.disabledSounds, event])]
          })),
        setSidebar: (sidebar) => set({ sidebar }),
        setAccountId: (accountId) => set({ accountId }),
        setFavouriteDm: (channelId, favourite) =>
          set((s) =>
            updateAccount(s, (a) => {
              const has = a.favouriteDms.includes(channelId)
              if (has === favourite) return a
              const favouriteDms = favourite
                ? [...a.favouriteDms, channelId]
                : a.favouriteDms.filter((id) => id !== channelId)
              return { ...a, favouriteDms }
            })
          ),
        moveFavouriteDm: (from, to) =>
          set((s) =>
            updateAccount(s, (a) => ({ ...a, favouriteDms: moved(a.favouriteDms, from, to) }))
          ),
        setNotifyLevel: (id, level) =>
          set((s) =>
            updateAccount(s, (a) => {
              const notify = { ...a.notify }
              if (level === null) delete notify[id]
              else notify[id] = level
              return { ...a, notify }
            })
          ),
        setMuted: (id, muted) =>
          set((s) =>
            updateAccount(s, (a) =>
              a.muted.includes(id) === muted
                ? a
                : { ...a, muted: muted ? [...a.muted, id] : a.muted.filter((m) => m !== id) }
            )
          ),
        updateTabs: (f) =>
          set((s) =>
            updateAccount(s, (a) => {
              const before = a.tabs ?? NO_TABS
              const tabs = f(before)
              return tabs === before ? a : { ...a, tabs }
            })
          )
      }),
      {
        name: 'hachiman-prefs-storage',
        partialize: (s) => {
          const rest: Partial<PrefsState> = { ...s }
          delete rest.accountId
          return rest
        }
      }
    )
  )
)

type AccountSlice = Pick<PrefsState, 'accounts' | 'accountId'>

/** Applies `f` to the signed-in account's preferences; no account = no change. */
function updateAccount(
  s: AccountSlice,
  f: (a: AccountPrefs) => AccountPrefs
): Partial<AccountSlice> {
  if (s.accountId === null) return {}
  const before = accountPrefs(s)
  const after = f(before)
  return after === before ? {} : { accounts: { ...s.accounts, [s.accountId]: after } }
}

/** `list` with the item at `from` moved to `to` (both clamped). */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list]
  if (from < 0 || from >= out.length) return out
  const [item] = out.splice(from, 1)
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item)
  return out
}

export const useSidebarMode = (): SidebarMode => usePrefsStore((s) => s.sidebar)
export const useFavouriteDms = (): string[] => usePrefsStore((s) => accountPrefs(s).favouriteDms)
/** The pinned tabs of the signed-in account (a stable empty list when none). */
export const accountTabs = (s: Pick<PrefsState, 'accounts' | 'accountId'>): TabTarget[] =>
  accountPrefs(s).tabs ?? NO_TABS
/** The notification preferences of the signed-in account (stable while unchanged). */
export const useNotifyPrefs = (): NotifyPrefs => usePrefsStore(accountPrefs)
/** The notification preferences, outside React. */
export const notifyPrefs = (): NotifyPrefs => accountPrefs(usePrefsStore.getState())
