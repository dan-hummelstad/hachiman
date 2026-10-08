import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type {
  CustomStatus,
  Guild,
  GuildEmoji,
  Member,
  PresenceStatus,
  Role
} from '@hachiman/client'

/** Mirror of the HachimanClient guild caches. Written only by services/hachiman.ts. */
interface GuildState {
  guilds: Map<string, Guild>
  roles: Map<string, Map<string, Role>> // guildId → roleId → Role
  members: Map<string, Map<string, Member>> // guildId → userId → Member
  presences: Map<string, PresenceStatus> // userId → status (absent = offline)
  /** userId → custom status (N16). Check `expiresAt` before you show it: use `useCustomStatus`. */
  customStatuses: Map<string, CustomStatus>
  /** guildId → custom emojis, oldest first. */
  emojis: Map<string, GuildEmoji[]>
  /** emojiId → emoji, over every guild: renders `<:name:id>` and `name:id` reactions. */
  emojiIndex: Map<string, GuildEmoji>
}

const initialGuildState = (): GuildState => ({
  guilds: new Map(),
  roles: new Map(),
  members: new Map(),
  presences: new Map(),
  customStatuses: new Map(),
  emojis: new Map(),
  emojiIndex: new Map()
})

export const useGuildStore = create<GuildState>()(devtools(initialGuildState))

export function resetGuildStore(): void {
  useGuildStore.setState(initialGuildState())
}
