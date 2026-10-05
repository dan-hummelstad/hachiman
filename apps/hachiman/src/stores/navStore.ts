import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

/** `guildKey` for the DM home (and the `channelByGuild` key for its open DM). */
export const DM_HOME = '@me'

/** Where the user is looking. Persisted; independent of the voice channel. */
interface NavState {
  /** Selected guild id, or DM_HOME. */
  guildKey: string
  /** guildKey → channel being viewed there. Absent = none (DM home: the People pane). */
  channelByGuild: Record<string, string>
  selectGuild: (guildKey: string) => void
  /** Select a channel in `guildKey` (default: the current one). null clears that guild's selection. */
  selectChannel: (channelId: string | null, guildKey?: string) => void
  /** Switch to `guildKey` and view `channelId` there. */
  openChannel: (guildKey: string, channelId: string) => void
  /** Drop a guild's remembered channel; leave it for the DM home if it's the selected one. */
  forgetGuild: (guildId: string) => void
}

export const useNavStore = create<NavState>()(
  devtools(
    persist(
      (set) => ({
        guildKey: DM_HOME,
        channelByGuild: {},
        selectGuild: (guildKey) => set({ guildKey }),
        selectChannel: (channelId, guildKey) =>
          set((s) => {
            const key = guildKey ?? s.guildKey
            const next = { ...s.channelByGuild }
            if (channelId === null) delete next[key]
            else next[key] = channelId
            return { channelByGuild: next }
          }),
        openChannel: (guildKey, channelId) =>
          set((s) => ({
            guildKey,
            channelByGuild: { ...s.channelByGuild, [guildKey]: channelId }
          })),
        forgetGuild: (guildId) =>
          set((s) => {
            const channelByGuild = { ...s.channelByGuild }
            delete channelByGuild[guildId]
            return { channelByGuild, guildKey: s.guildKey === guildId ? DM_HOME : s.guildKey }
          })
      }),
      {
        name: 'hachiman-nav-storage',
        partialize: (s) => ({ guildKey: s.guildKey, channelByGuild: s.channelByGuild })
      }
    )
  )
)

/** The selected guild id; null = the DM home. */
export const useSelectedGuildId = (): string | null =>
  useNavStore((s) => (s.guildKey === DM_HOME ? null : s.guildKey))

/** The channel being viewed in the selected guild (or DM home), if any. */
export const useSelectedChannelId = (): string | null =>
  useNavStore((s) => s.channelByGuild[s.guildKey] ?? null)

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
