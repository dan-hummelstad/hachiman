import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import { DEFAULT_CUSTOM_GRADIENT, isCustomGradient, type CustomGradient } from '@/lib/guild-tint'
import type { StreamQuality } from '@/lib/stream-quality'
import type { SoundEvent } from '@/lib/sounds'
import type { NotifyLevel, NotifyPrefs } from '@/lib/notify'
import type { TabTarget } from '@/stores/tabsStore'
import type { KeybindAction, KeybindOverrides } from '@/lib/keybinds'

export type MessageDisplay = 'cozy' | 'compact'
/** `system` follows the OS colour scheme. Applied to `<html>` by `ThemeProvider`. */
export type Theme = 'dark' | 'light' | 'system'
/** N3: the sidebar docked beside the content, or hidden and shown on hover. */
export type SidebarMode = 'docked' | 'undocked'
/** Mic noise suppression: none, the browser's own (getUserMedia), or RNNoise in an AudioWorklet. */
export type NoiseSuppression = 'off' | 'browser' | 'rnnoise'
/** The window wallpaper: tinted by the selected guild (N4), or the user's own gradient. */
export type WallpaperMode = 'guild' | 'custom'

/** How the mic opens in voice: on speech (VAD), or only while the push-to-talk key is held. */
export type VoiceInputMode = 'voiceActivity' | 'pushToTalk'

/** The preferences of one account on this device (N1, N6, N9). */
export interface AccountPrefs extends NotifyPrefs {
  /** Guild ids in the order the user set (the guild row). Guilds not in it follow, in READY order. */
  guildOrder?: string[]
  /** The pinned tabs (N1), in tab order. Absent in data stored before tabs moved here. */
  tabs?: TabTarget[]
}

/** What I hear of one other user in voice (Discord's user volume). Only this device plays it. */
export interface UserAudio {
  /** 0..2; 1 = unchanged. */
  volume: number
  /** Local mute: I do not hear the user. The user does not know. */
  muted: boolean
}

export const DEFAULT_USER_AUDIO: UserAudio = { volume: 1, muted: false }

const EMPTY_ACCOUNT: AccountPrefs = { notify: {}, muted: [] }

/** Local, per-device UI preferences. Written by the user settings overlay. */
interface PrefsState {
  theme: Theme
  messageDisplay: MessageDisplay
  /** `MediaDeviceInfo.deviceId`; null = the system default. */
  inputDeviceId: string | null
  outputDeviceId: string | null
  /** Applies to a live call too (the mic restarts). */
  noiseSuppression: NoiseSuppression
  /** The mic send bitrate (Opus), bit/s. Applies to a live call too. */
  micBitrate: number
  /** Mic capture processing (getUserMedia). A change restarts a live mic. */
  echoCancellation: boolean
  /** Screen share capture and send quality. Applies to a live share too. */
  streamQuality: StreamQuality
  /** Notification and voice sounds (SoundService). */
  soundsEnabled: boolean
  /** 0..1 */
  soundVolume: number
  /** Sounds the user switched off one by one. Ignored while `soundsEnabled` is false. */
  disabledSounds: SoundEvent[]
  /** userId → local volume and mute in voice. A user at the default has no entry. */
  userAudio: Record<string, UserAudio>
  /** userId → local volume and mute of that user's screen share audio. Default = no entry. */
  streamAudio: Record<string, UserAudio>
  /** "Share audio" in the in-app share picker. */
  shareScreenAudio: boolean
  sidebar: SidebarMode
  wallpaper: WallpaperMode
  /** The gradient while `wallpaper` is `custom`. Kept when the user goes back to the guild tint. */
  customGradient: CustomGradient
  /** The user's keybind changes (lib/keybinds.ts); a missing action keeps its default. */
  keybinds: KeybindOverrides
  voiceInputMode: VoiceInputMode
  /** Desktop: the keybinds marked `global` also work while Hachiman is in the background. */
  globalKeybinds: boolean
  /** Width in px of the right column while it shows a page (the user drags its edge). */
  pageColumnWidth: number
  /** The emoji picker's recently used emojis, newest first: Unicode emojis and custom `name:id` keys. */
  recentEmojis: string[]
  /** The picker's skin tone: 0 the default, 1 to 5 light to dark. */
  skinTone: number
  /** userId → that account's preferences. */
  accounts: Record<string, AccountPrefs>
  /** The signed-in user id. Not persisted: services/hachiman.ts sets it. */
  accountId: string | null
  setTheme: (theme: Theme) => void
  setMessageDisplay: (messageDisplay: MessageDisplay) => void
  setInputDeviceId: (inputDeviceId: string | null) => void
  setOutputDeviceId: (outputDeviceId: string | null) => void
  setNoiseSuppression: (noiseSuppression: NoiseSuppression) => void
  setMicBitrate: (micBitrate: number) => void
  setEchoCancellation: (echoCancellation: boolean) => void
  setStreamQuality: (streamQuality: StreamQuality) => void
  setSoundsEnabled: (soundsEnabled: boolean) => void
  setSoundVolume: (soundVolume: number) => void
  setSoundEnabled: (event: SoundEvent, enabled: boolean) => void
  setUserAudio: (userId: string, change: Partial<UserAudio>) => void
  setStreamAudio: (userId: string, change: Partial<UserAudio>) => void
  setShareScreenAudio: (shareScreenAudio: boolean) => void
  setSidebar: (sidebar: SidebarMode) => void
  setWallpaper: (wallpaper: WallpaperMode) => void
  setCustomGradient: (customGradient: CustomGradient) => void
  /** `combo` null: no key. */
  setKeybind: (action: KeybindAction, combo: string | null) => void
  /** Back to the default key; no `action`: every action. */
  resetKeybind: (action?: KeybindAction) => void
  setVoiceInputMode: (voiceInputMode: VoiceInputMode) => void
  setGlobalKeybinds: (globalKeybinds: boolean) => void
  setPageColumnWidth: (pageColumnWidth: number) => void
  setAccountId: (accountId: string | null) => void
  /** Moves `key` to the front of `recentEmojis`. */
  addRecentEmoji: (key: string) => void
  setSkinTone: (skinTone: number) => void
  /** Replaces the guild order of the signed-in account. */
  setGuildOrder: (guildOrder: string[]) => void
  /** null clears the level of `id` (channel or guild): it follows its parent or the default. */
  setNotifyLevel: (id: string, level: NotifyLevel | null) => void
  setMuted: (id: string, muted: boolean) => void
  /** Replaces the tabs of the signed-in account with `f(tabs)`; returning `tabs` changes nothing. */
  updateTabs: (f: (tabs: TabTarget[]) => TabTarget[]) => void
}

const NO_TABS: TabTarget[] = []
export const MAX_RECENT_EMOJIS = 30

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
        noiseSuppression: 'rnnoise',
        micBitrate: 64_000,
        echoCancellation: true,
        streamQuality: { resolution: '1080p', fps: 30 },
        soundsEnabled: true,
        soundVolume: 0.7,
        disabledSounds: [],
        userAudio: {},
        streamAudio: {},
        shareScreenAudio: true,
        sidebar: 'docked',
        wallpaper: 'guild',
        customGradient: DEFAULT_CUSTOM_GRADIENT,
        keybinds: {},
        voiceInputMode: 'voiceActivity',
        globalKeybinds: true,
        pageColumnWidth: 540,
        recentEmojis: [],
        skinTone: 0,
        accounts: {},
        accountId: null,
        setTheme: (theme) => set({ theme }),
        setMessageDisplay: (messageDisplay) => set({ messageDisplay }),
        setInputDeviceId: (inputDeviceId) => set({ inputDeviceId }),
        setOutputDeviceId: (outputDeviceId) => set({ outputDeviceId }),
        setMicBitrate: (micBitrate) => set({ micBitrate }),
        setEchoCancellation: (echoCancellation) => set({ echoCancellation }),
        setNoiseSuppression: (noiseSuppression) => set({ noiseSuppression }),
        setStreamQuality: (streamQuality) => set({ streamQuality }),
        setSoundsEnabled: (soundsEnabled) => set({ soundsEnabled }),
        setSoundVolume: (soundVolume) => set({ soundVolume }),
        setSoundEnabled: (event, enabled) =>
          set((s) => ({
            disabledSounds: enabled
              ? s.disabledSounds.filter((e) => e !== event)
              : [...new Set([...s.disabledSounds, event])]
          })),
        setUserAudio: (userId, change) =>
          set((s) => ({ userAudio: withAudio(s.userAudio, userId, change) })),
        setStreamAudio: (userId, change) =>
          set((s) => ({ streamAudio: withAudio(s.streamAudio, userId, change) })),
        setShareScreenAudio: (shareScreenAudio) => set({ shareScreenAudio }),
        setSidebar: (sidebar) => set({ sidebar }),
        setWallpaper: (wallpaper) => set({ wallpaper }),
        setCustomGradient: (customGradient) => set({ customGradient }),
        setKeybind: (action, combo) =>
          set((s) => ({ keybinds: { ...s.keybinds, [action]: combo } })),
        resetKeybind: (action) =>
          set((s) => {
            if (!action) return { keybinds: {} }
            const keybinds = { ...s.keybinds }
            delete keybinds[action]
            return { keybinds }
          }),
        setVoiceInputMode: (voiceInputMode) => set({ voiceInputMode }),
        setGlobalKeybinds: (globalKeybinds) => set({ globalKeybinds }),
        setPageColumnWidth: (pageColumnWidth) => set({ pageColumnWidth }),
        setAccountId: (accountId) => set({ accountId }),
        addRecentEmoji: (key) =>
          set((s) => ({
            recentEmojis: [key, ...s.recentEmojis.filter((k) => k !== key)].slice(
              0,
              MAX_RECENT_EMOJIS
            )
          })),
        setSkinTone: (skinTone) => set({ skinTone }),
        setGuildOrder: (guildOrder) => set((s) => updateAccount(s, (a) => ({ ...a, guildOrder }))),
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
        },
        // A stored gradient of an older shape falls back to the default.
        merge: (persisted, current) => {
          const p = (persisted ?? {}) as Partial<PrefsState>
          return {
            ...current,
            ...p,
            customGradient: isCustomGradient(p.customGradient)
              ? p.customGradient
              : current.customGradient
          }
        }
      }
    )
  )
)

/** `map` with `change` applied to `userId`'s entry. An entry back at the default is removed. */
function withAudio(
  map: Record<string, UserAudio>,
  userId: string,
  change: Partial<UserAudio>
): Record<string, UserAudio> {
  const next = { ...(map[userId] ?? DEFAULT_USER_AUDIO), ...change }
  const out = { ...map }
  if (next.volume === 1 && !next.muted) delete out[userId]
  else out[userId] = next
  return out
}

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
const NO_ORDER: string[] = []
/** The guild order of the signed-in account (a stable empty list when none). */
export const useGuildOrder = (): string[] =>
  usePrefsStore((s) => accountPrefs(s).guildOrder ?? NO_ORDER)
/** The pinned tabs of the signed-in account (a stable empty list when none). */
export const accountTabs = (s: Pick<PrefsState, 'accounts' | 'accountId'>): TabTarget[] =>
  accountPrefs(s).tabs ?? NO_TABS
/** The notification preferences of the signed-in account (stable while unchanged). */
export const useNotifyPrefs = (): NotifyPrefs => usePrefsStore(accountPrefs)
/** The notification preferences, outside React. */
export const notifyPrefs = (): NotifyPrefs => accountPrefs(usePrefsStore.getState())
