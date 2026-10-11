import { Permissions, has, type Member, type Role } from '@hachiman/client'
import { displayName, rolesByPositionDesc } from '@/lib/model'

/** What I may do to one member on the Members page (contract §4, PATCH and DELETE members). */
export interface MemberGate {
  isSelf: boolean
  isOwner: boolean
  /** Nickname: CHANGE_NICKNAME on myself, MANAGE_NICKNAMES on others. */
  canNick: boolean
  /** Kick: KICK_MEMBERS, never the owner or myself. */
  canKick: boolean
}

/** The gates of the member `userId`, from my permissions in the guild. */
export function memberGate(
  userId: string,
  me: { perms: number; myId: string | undefined; ownerId: string }
): MemberGate {
  const isSelf = userId === me.myId
  const isOwner = userId === me.ownerId
  return {
    isSelf,
    isOwner,
    canNick: has(me.perms, isSelf ? Permissions.CHANGE_NICKNAME : Permissions.MANAGE_NICKNAMES),
    canKick: has(me.perms, Permissions.KICK_MEMBERS) && !isOwner && !isSelf
  }
}

/** The roles I may add or remove: below my ceiling, highest first, never @everyone (id = guild id). */
export function assignableRoles(roles: Iterable<Role>, guildId: string, ceiling: number): Role[] {
  return rolesByPositionDesc([...roles].filter((r) => r.id !== guildId && r.position < ceiling))
}

/** The members whose display name or username contains `query` (trimmed, any case). */
export function filterMembers(members: Member[], query: string): Member[] {
  const q = query.trim().toLowerCase()
  if (!q) return members
  return members.filter(
    (m) => displayName(m).toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q)
  )
}

/** The role ids with `roleId` added, or taken out when the member has it. */
export function toggleRole(roleIds: readonly string[], roleId: string): string[] {
  return roleIds.includes(roleId) ? roleIds.filter((id) => id !== roleId) : [...roleIds, roleId]
}

/** "12 members · 9 online" (M54: the section label shows it in caps). */
export function membersLine(total: number, online: number): string {
  return `${total} ${total === 1 ? 'member' : 'members'} · ${online} online`
}

/** The kick confirm (desktop and M54): the same words on both layouts. */
export function kickCopy(name: string): { title: string; body: string; what: string } {
  return {
    title: `Kick ${name}?`,
    body: 'They leave the guild now. They can come back with a new invite.',
    what: `kick ${name}`
  }
}
