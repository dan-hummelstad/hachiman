import type { Member, PresenceStatus } from '@hachiman/client'
import { displayName } from '@/lib/model'

/** One section of the members column: "ONLINE — n", "OFFLINE — n". */
export interface MemberGroup {
  /** Stable key of the section. */
  id: string
  /** The heading without the count. */
  label: string
  members: Member[]
  /** The rows render dimmed (offline). */
  dim: boolean
}

const isOnline = (status: PresenceStatus | undefined): boolean =>
  status !== undefined && status !== 'offline'

/**
 * The sections of the members column, each sorted by display name. Empty sections are left out.
 * Today: online and offline. Hoisted roles (feature plan N15) add their sections before "Online".
 */
export function groupMembers(
  members: Iterable<Member>,
  presences: ReadonlyMap<string, PresenceStatus>
): MemberGroup[] {
  const online: Member[] = []
  const offline: Member[] = []
  for (const m of members) (isOnline(presences.get(m.user.id)) ? online : offline).push(m)
  const byName = (a: Member, b: Member): number => displayName(a).localeCompare(displayName(b))
  const groups: MemberGroup[] = [
    { id: 'online', label: 'Online', members: online.sort(byName), dim: false },
    { id: 'offline', label: 'Offline', members: offline.sort(byName), dim: true }
  ]
  return groups.filter((g) => g.members.length > 0)
}
