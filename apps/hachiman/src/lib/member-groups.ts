import type { Member, PresenceStatus, Role } from '@hachiman/client'
import { displayName, hexColor, rolesByPositionDesc } from '@/lib/model'

/** One section of the members column: "CAPTAIN — n", "ONLINE — n", "OFFLINE — n". */
export interface MemberGroup {
  /** Stable key of the section: the role id, 'online' or 'offline'. */
  id: string
  /** The heading without the count. */
  label: string
  members: Member[]
  /** The rows render dimmed (offline). */
  dim: boolean
  /** The colour square of a hoisted role (`#rrggbb`). Unset for Online, Offline and a role without colour. */
  color?: string
}

const isOnline = (status: PresenceStatus | undefined): boolean =>
  status !== undefined && status !== 'offline'

/**
 * The sections of the members column (feature plan N15), each sorted by display name. Empty
 * sections are left out.
 * - Online members go into the section of their highest hoisted role (by position, ties by id),
 *   sections in role order.
 * - Online members with no hoisted role: "Online".
 * - All offline members, hoisted or not: "Offline", last.
 */
export function groupMembers(
  members: Iterable<Member>,
  presences: ReadonlyMap<string, PresenceStatus>,
  roles?: ReadonlyMap<string, Role>
): MemberGroup[] {
  const hoisted = rolesByPositionDesc([...(roles?.values() ?? [])].filter((r) => r.hoist))
  const rank = new Map(hoisted.map((r, i) => [r.id, i]))
  const byRole: Member[][] = hoisted.map(() => [])
  const online: Member[] = []
  const offline: Member[] = []
  for (const m of members) {
    if (!isOnline(presences.get(m.user.id))) {
      offline.push(m)
      continue
    }
    let best: number | undefined
    for (const id of m.roles) {
      const r = rank.get(id)
      if (r !== undefined && (best === undefined || r < best)) best = r
    }
    ;(best === undefined ? online : (byRole[best] ?? online)).push(m)
  }
  const byName = (a: Member, b: Member): number => displayName(a).localeCompare(displayName(b))
  const groups: MemberGroup[] = hoisted.map((role, i) => ({
    id: role.id,
    label: role.name,
    members: (byRole[i] ?? []).sort(byName),
    dim: false,
    ...(role.color !== 0 ? { color: hexColor(role.color) } : {})
  }))
  groups.push(
    { id: 'online', label: 'Online', members: online.sort(byName), dim: false },
    { id: 'offline', label: 'Offline', members: offline.sort(byName), dim: true }
  )
  return groups.filter((g) => g.members.length > 0)
}
