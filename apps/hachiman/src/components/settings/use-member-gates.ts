import { useCallback, useMemo } from 'react'
import { Permissions, has, type Guild, type Member, type Role } from '@hachiman/client'
import {
  assignableRoles,
  memberGate,
  toggleRole,
  type MemberGate
} from '@/components/settings/member-gates'
import type { Action, ActionResult } from '@/hooks/use-action'
import { usePermissions, useRoleCeiling } from '@/hooks/use-hachiman'
import { sortMembersByName } from '@/lib/model'
import { adminActionService } from '@/services/AdminActionService'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'

const NO_ROLES: Role[] = []

export interface MemberGates {
  /** The guild's members by display name. */
  sorted: Member[]
  roles: Map<string, Role> | undefined
  /** The roles I may add or remove on a member; empty without MANAGE_ROLES. */
  assignable: Role[]
  gate: (member: Member) => MemberGate
}

/**
 * The Members page data with the server's gates (contract §4): roles → MANAGE_ROLES and the
 * hierarchy; nick → CHANGE_NICKNAME on myself, MANAGE_NICKNAMES on others; kick → KICK_MEMBERS,
 * never the owner or myself. Both layouts read it.
 */
export function useMemberGates(guild: Guild): MemberGates {
  const members = useGuildStore((s) => s.members.get(guild.id))
  const roles = useGuildStore((s) => s.roles.get(guild.id))
  const myId = useUserStore((s) => s.me?.id)
  const perms = usePermissions(guild.id)
  const ceiling = useRoleCeiling(guild.id)
  const canRoles = has(perms, Permissions.MANAGE_ROLES)

  const sorted = useMemo(() => sortMembersByName(members?.values() ?? []), [members])
  const assignable = useMemo(
    () => (canRoles ? assignableRoles(roles?.values() ?? [], guild.id, ceiling) : NO_ROLES),
    [canRoles, roles, guild.id, ceiling]
  )
  const gate = useCallback(
    (m: Member) => memberGate(m.user.id, { perms, myId, ownerId: guild.ownerId }),
    [perms, myId, guild.ownerId]
  )
  return useMemo(() => ({ sorted, roles, assignable, gate }), [sorted, roles, assignable, gate])
}

export interface MemberEdit {
  /** Sets the member's roles: a signed admin action (contract §12.6). */
  setRoles: (roleIds: string[]) => Promise<ActionResult<unknown>>
  toggleRole: (roleId: string) => Promise<ActionResult<unknown>>
  /** Sets the nickname; an empty one clears it. */
  saveNick: (nick: string) => Promise<ActionResult<unknown>>
}

/** The edits of one member, run through `run` (so its owner shows the busy state and errors). */
export function useMemberEdit(member: Member, name: string, run: Action['run']): MemberEdit {
  const { guildId, roles } = member
  const userId = member.user.id
  return useMemo(() => {
    const setRoles = (next: string[]): Promise<ActionResult<unknown>> =>
      run(`update roles for ${name}`, () =>
        adminActionService.updateMember(guildId, userId, { roles: next })
      )
    return {
      setRoles,
      toggleRole: (roleId) => setRoles(toggleRole(roles, roleId)),
      saveNick: (nick) =>
        run(`change the nickname for ${name}`, () =>
          adminActionService.updateMember(guildId, userId, { nick: nick.trim() || null })
        )
    }
  }, [guildId, userId, roles, name, run])
}
