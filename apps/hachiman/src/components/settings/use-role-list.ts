import { useMemo, useState } from 'react'
import { Permissions, type Role } from '@hachiman/client'
import { useAction, type ActionResult } from '@/hooks/use-action'
import { trimName, useDraft, type Draft } from '@/hooks/use-draft'
import { useRoleCeiling } from '@/hooks/use-hachiman'
import { rolesByPositionDesc } from '@/lib/model'
import { adminActionService } from '@/services/AdminActionService'
import { useGuildStore } from '@/stores/guildStore'

/** The colour row of the role editor (0 = no colour). The stored values, not the mock's. */
export const SWATCHES: readonly number[] = [
  0xffc36b, 0xff8fc4, 0xff6b6b, 0xc9a2ff, 0x8b7bff, 0x7fd3ff, 0x5ee6d0, 0x5ed98a
]

/** The spoken name of each swatch, for its radio's label (VoiceOver does not read a hex code). */
export const SWATCH_NAMES: ReadonlyMap<number, string> = new Map([
  [0xffc36b, 'Gold'],
  [0xff8fc4, 'Pink'],
  [0xff6b6b, 'Red'],
  [0xc9a2ff, 'Lilac'],
  [0x8b7bff, 'Violet'],
  [0x7fd3ff, 'Sky'],
  [0x5ee6d0, 'Teal'],
  [0x5ed98a, 'Green']
])

/** A colour that is set and is none of the swatches: the Custom choice is on. */
export const isCustomColour = (color: number): boolean => color !== 0 && !SWATCHES.includes(color)

/** The value of an `<input type="color">` (`#rrggbb`) as a role colour. */
export const colourFromHex = (hex: string): number => parseInt(hex.slice(1), 16)

/** A role's id and position, the shape of the reorder body. */
export interface RolePlace {
  id: string
  position: number
}

/**
 * Whether the role at `i` of `movable` (highest first, no @everyone) can move one up. The role and
 * the one above it must both be below `ceiling`, or the move would jump past it.
 */
export function canMoveHigher(movable: readonly RolePlace[], i: number, ceiling: number): boolean {
  return (
    i > 0 &&
    i < movable.length &&
    movable[i].position < ceiling &&
    movable[i - 1].position < ceiling
  )
}

/** Whether the role at `i` of `movable` can move one down: it is below `ceiling` and not last. */
export function canMoveLower(movable: readonly RolePlace[], i: number, ceiling: number): boolean {
  return i >= 0 && i < movable.length - 1 && movable[i].position < ceiling
}

/**
 * The reorder body that moves the role at `from` of `movable` (highest first, no @everyone) to
 * index `to`, or null when the move is out of range, a no-op, or touches a role at or above
 * `ceiling`. Only the roles between the two places change position, and they take the same set of
 * positions in the new order, so a non-admin never sends a role above the ceiling. Duplicate
 * positions (legacy data) fall back to renumbering n..1. Roles that keep their position are left
 * out.
 */
export function reorderBody(
  movable: readonly RolePlace[],
  from: number,
  to: number,
  ceiling: number
): RolePlace[] | null {
  if (from < 0 || from >= movable.length || to < 0 || to >= movable.length || to === from) {
    return null
  }
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const span = movable.slice(lo, hi + 1)
  if (span.some((r) => r.position >= ceiling)) return null
  const order = [...movable]
  const [role] = order.splice(from, 1)
  order.splice(to, 0, role)
  const positions = span.map((r) => r.position)
  if (new Set(positions).size === positions.length) {
    return order
      .slice(lo, hi + 1)
      .map((r, k) => ({ id: r.id, position: positions[k] }))
      .filter((r, k) => order[lo + k].position !== r.position)
  }
  return order
    .map((r, k) => ({ id: r.id, position: order.length - k }))
    .filter((r, k) => r.position !== order[k].position)
}

export interface RoleList {
  /** Every role, highest first; @everyone (id = guild id) is last. */
  roles: Role[]
  /** The picked role, else the highest. */
  selected: Role | undefined
  /** Picks a role; null goes back to the highest. */
  select: (id: string | null) => void
  /** The roles that can move: all but @everyone. */
  movable: Role[]
  /** My highest role position; a role at or above it is not mine to edit. */
  ceiling: number
  /** The members that hold the role; all members for @everyone. */
  count: (role: Role) => number
  /** Creates "new role" and picks it. */
  create: () => Promise<void>
  /** Moves `role` to index `to` of `movable` (see `reorderBody`). */
  moveTo: (role: Role, to: number) => void
  canMoveHigher: (role: Role) => boolean
  canMoveLower: (role: Role) => boolean
  /** The error of the last create or reorder. */
  error: string | null
}

/**
 * The role list of Guild settings → Roles (G2, M53): the roles in order, the picked one, member
 * counts, create and reorder. Both layouts use it.
 */
export function useRoleList(guildId: string): RoleList {
  const roleMap = useGuildStore((s) => s.roles.get(guildId))
  const members = useGuildStore((s) => s.members.get(guildId))
  const ceiling = useRoleCeiling(guildId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { run, error } = useAction()

  const roles = useMemo(() => rolesByPositionDesc(roleMap?.values() ?? []), [roleMap])
  // @everyone (id === guildId) is pinned at position 0 and never moves.
  const movable = useMemo(() => roles.filter((r) => r.id !== guildId), [roles, guildId])
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const member of members?.values() ?? [])
      for (const id of member.roles) m.set(id, (m.get(id) ?? 0) + 1)
    return m
  }, [members])

  const create = async (): Promise<void> => {
    const created = await run('create the role', () =>
      adminActionService.createRole(guildId, { name: 'new role' })
    )
    if (created.ok) setSelectedId(created.value.id)
  }

  const moveTo = (role: Role, to: number): void => {
    const body = reorderBody(movable, movable.indexOf(role), to, ceiling)
    if (body) void run('reorder roles', () => adminActionService.reorderRoles(guildId, body))
  }

  return {
    roles,
    selected: roles.find((r) => r.id === selectedId) ?? roles[0],
    select: setSelectedId,
    movable,
    ceiling,
    count: (role) => (role.id === guildId ? (members?.size ?? 0) : (counts.get(role.id) ?? 0)),
    create,
    moveTo,
    canMoveHigher: (role) => canMoveHigher(movable, movable.indexOf(role), ceiling),
    canMoveLower: (role) => canMoveLower(movable, movable.indexOf(role), ceiling),
    error
  }
}

export interface RoleDraftFields {
  name: string
  color: number
  permissions: number
}

export interface RoleDraft {
  draft: Draft<RoleDraftFields>
  /** Administrator is on in the draft: every other permission shows as on through it. */
  admin: boolean
  busy: boolean
  error: string | null
  /** Saves the draft. A permissions change is a signed admin action (§12.16). */
  save: () => Promise<ActionResult<Role>>
}

/**
 * The edit state of one role. Key the editor on the role id: gateway updates to other fields
 * do not clobber the draft.
 */
export function useRoleDraft(role: Role, isEveryone: boolean): RoleDraft {
  const draft = useDraft<RoleDraftFields>(
    { name: role.name, color: role.color, permissions: role.permissions },
    trimName
  )
  const { name, color, permissions } = draft.value
  const { run, busy, error } = useAction()

  const save = (): Promise<ActionResult<Role>> =>
    run('save the role', () =>
      adminActionService.updateRole(role.guildId, role.id, {
        name: isEveryone ? undefined : name.trim(),
        color,
        // Send permissions only when they changed, so a rename needs no signature.
        permissions: permissions !== role.permissions ? permissions : undefined
      })
    )

  return {
    draft,
    admin: (permissions & Permissions.ADMINISTRATOR) !== 0,
    busy,
    error,
    save
  }
}
