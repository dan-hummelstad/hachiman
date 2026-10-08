import type { Member, PresenceStatus, User } from '@hachiman/client'
import { useAction } from '@/hooks/use-action'
import { displayName, roleColor } from '@/lib/model'
import { roleInk } from '@/lib/role-ink'
import { openDmWith } from '@/services/hachiman'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** A user's presence; absent (or no user) = 'offline'. */
export function usePresence(userId: string | null | undefined): PresenceStatus {
  return useGuildStore((s) => (userId ? (s.presences.get(userId) ?? 'offline') : 'offline'))
}

/**
 * A guild member as rendered: the member (undefined outside a guild or if unknown), their display
 * name and avatar key (both falling back to `user` for DMs), and their role ink (role color
 * adjusted for the theme; needs a ROLE_INK_SCOPE ancestor).
 */
export function useMemberView(
  guildId: string | null | undefined,
  userId: string,
  user?: User
): { member: Member | undefined; name: string; avatar: string | null; ink: string | undefined } {
  const member = useGuildStore((s) => (guildId ? s.members.get(guildId)?.get(userId) : undefined))
  const roles = useGuildStore((s) => (guildId ? s.roles.get(guildId) : undefined))
  const known = useDmUser(guildId || user ? null : userId)
  const who = user ?? known
  return {
    member,
    name: displayName(member, who),
    avatar: member?.user.avatar ?? who?.avatar ?? null,
    ink: roleInk(roleColor(member, roles))
  }
}

/** Me or a DM recipient with `userId` (a DM call has no guild members). Null: no lookup. */
function useDmUser(userId: string | null): User | undefined {
  const me = useUserStore((s) => (userId && s.me?.id === userId ? s.me : undefined))
  const other = useChannelStore((s) => {
    if (!userId) return undefined
    for (const c of s.channels.values())
      if (c.guildId === null) {
        const u = c.recipients?.find((r) => r.id === userId)
        if (u) return u
      }
    return undefined
  })
  return me ?? other
}

/** A member as rendered (member list, voice occupants): `useMemberView` plus whether they are speaking. */
export function useSpeakingMember(
  guildId: string | null,
  userId: string
): ReturnType<typeof useMemberView> & { speaking: boolean } {
  const speaking = useVoiceStore((s) => s.speaking.has(userId))
  return { ...useMemberView(guildId, userId), speaking }
}

/** Open (or reuse) a DM with `userId` and switch to it. `open` resolves false on failure (logged). */
export function useOpenDm(userId: string): { open: () => Promise<boolean>; busy: boolean } {
  const { run, busy } = useAction()
  const open = async (): Promise<boolean> =>
    (await run('open the conversation', () => openDmWith(userId))).ok
  return { open, busy }
}
