import { useMemo } from 'react'
import {
  Permissions,
  effectivePermissions,
  has,
  highestRolePosition,
  type Channel,
  type VoiceState
} from '@hachiman/client'
import { compareChannels } from '@/lib/model'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

const EMPTY_CHANNELS: Channel[] = []

/** A guild's channels (all types) in sidebar order. */
export function useGuildChannels(guildId: string | null): Channel[] {
  const channels = useChannelStore((s) => s.channels)
  return useMemo(() => {
    if (!guildId) return EMPTY_CHANNELS
    return [...channels.values()].filter((c) => c.guildId === guildId).sort(compareChannels)
  }, [channels, guildId])
}

const EMPTY_VOICE_STATES: VoiceState[] = []

/** Voice states of the users in one channel (join order); a stable empty array when none. */
export function useChannelOccupants(guildId: string | null, channelId: string): VoiceState[] {
  const states = useVoiceStore((s) => (guildId ? s.voiceStates.get(guildId) : undefined))
  return useMemo(() => {
    const list: VoiceState[] = []
    for (const vs of states?.values() ?? []) if (vs.channelId === channelId) list.push(vs)
    return list.length > 0 ? list : EMPTY_VOICE_STATES
  }, [states, channelId])
}

/** DM + group DM channels. */
export function useDmChannels(): Channel[] {
  const channels = useChannelStore((s) => s.channels)
  return useMemo(() => [...channels.values()].filter((c) => c.guildId === null), [channels])
}

/**
 * Current user's permission bits in a guild (channelId omitted or unknown) or a channel.
 * Same rules as `HachimanClient.permissionsFor` / `guildPermissions`, computed from the stores.
 */
export function usePermissions(guildId: string | null, channelId?: string | null): number {
  const channel = useChannelStore((s) => (channelId ? s.channels.get(channelId) : undefined))
  const gid = channel ? channel.guildId : guildId
  const myId = useUserStore((s) => s.me?.id)
  const guild = useGuildStore((s) => (gid ? s.guilds.get(gid) : undefined))
  const roles = useGuildStore((s) => (gid ? s.roles.get(gid) : undefined))
  const member = useGuildStore((s) => (gid && myId ? s.members.get(gid)?.get(myId) : undefined))
  return useMemo(
    () => effectivePermissions({ guild, member, roles, channel }),
    [channel, guild, member, roles]
  )
}

/**
 * Role-hierarchy ceiling for the current user (contract §2): roles with `position` strictly
 * below it are editable/assignable. Owner and ADMINISTRATOR are exempt (Infinity).
 */
export function useRoleCeiling(guildId: string | null): number {
  const perms = usePermissions(guildId)
  const myId = useUserStore((s) => s.me?.id)
  const me = useGuildStore((s) => (guildId && myId ? s.members.get(guildId)?.get(myId) : undefined))
  const roles = useGuildStore((s) => (guildId ? s.roles.get(guildId) : undefined))
  if (has(perms, Permissions.ADMINISTRATOR)) return Infinity // owner's ALL includes it
  return me && roles ? highestRolePosition(me, roles) : 0
}

/** Whether the signed-in user owns `guildId`. */
export function useIsGuildOwner(guildId: string | null | undefined): boolean {
  const myId = useUserStore((s) => s.me?.id)
  const ownerId = useGuildStore((s) => (guildId ? s.guilds.get(guildId)?.ownerId : undefined))
  return myId !== undefined && ownerId === myId
}
