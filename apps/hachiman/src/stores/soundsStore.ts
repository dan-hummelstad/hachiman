import { create } from 'zustand'
import type { GuildSound } from '@hachiman/client'

/**
 * The soundboard of each loaded guild, oldest first (contract §4 Soundboard). The rows hold the
 * sound pointer only as its envelope (ciphertext). The decrypted pointer and audio stay in
 * services/soundboard.ts, never in a store.
 */
interface SoundsState {
  byGuild: Map<string, GuildSound[]>
}

export const useSoundsStore = create<SoundsState>()(() => ({ byGuild: new Map() }))

const EMPTY_SOUNDS: GuildSound[] = []

export function useGuildSounds(guildId: string | null): GuildSound[] {
  return useSoundsStore((s) => (guildId ? (s.byGuild.get(guildId) ?? EMPTY_SOUNDS) : EMPTY_SOUNDS))
}
