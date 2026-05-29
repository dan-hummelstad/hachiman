import { useEffect, useState } from 'react'
import { serversService } from '@/services/ServersService'

const ROOT_CHANNEL_ID = 0

export interface ServerRoleInfo {
  /** Role/group name as defined on the server. */
  name: string
  /** Set of registered userIds that belong to this role (add ∪ inherited − remove). */
  memberIds: Set<number>
}

export interface ServerRolesSnapshot {
  /** Roles in display order (server order, with builtins de-prioritised). */
  roles: ServerRoleInfo[]
  /** Map of registered userId → display name (from fetchRegisteredUsers). */
  userNameById: Map<number, string>
  /** True while the initial fetch is in flight. */
  loading: boolean
  /**
   * Non-null when the fetch was rejected — typically PermissionDenied
   * because the current Mumble session lacks WritePermission on the root
   * channel. Callers should fall back to a flat member list.
   */
  error: string | null
}

const EMPTY: ServerRolesSnapshot = {
  roles: [],
  userNameById: new Map(),
  loading: false,
  error: null
}

/**
 * Fetches the root-channel ACL + registered-user list once per connected
 * server. The result drives the role-grouped right-hand member list.
 *
 * Note: both underlying RPCs require `WritePermission` (root ACL) and
 * `RegisterPermission` (registered users) — usually that means SuperUser
 * or members of the `admin` group. For non-admin sessions the fetch fails
 * with PermissionDenied; we surface that via `error` so the caller can
 * fall back to a permissionless view.
 */
export function useServerRoles(serverId: string | null): ServerRolesSnapshot {
  const [snapshot, setSnapshot] = useState<ServerRolesSnapshot>(EMPTY)

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!serverId) {
      setSnapshot(EMPTY)
      return
    }
    const service = serversService.getServer(serverId)
    if (!service || !service.isConnected()) {
      setSnapshot(EMPTY)
      return
    }
    let cancelled = false
    setSnapshot({ roles: [], userNameById: new Map(), loading: true, error: null })
    void (async () => {
      try {
        const [users, acl] = await Promise.all([
          service.fetchRegisteredUsers(),
          service.fetchAcl(ROOT_CHANNEL_ID)
        ])
        if (cancelled) return
        const userNameById = new Map<number, string>()
        for (const u of users) userNameById.set(u.userId, u.name)
        const roles: ServerRoleInfo[] = acl.groups.map((g) => {
          const members = new Set<number>([...g.add, ...g.inheritedMembers])
          for (const id of g.remove) members.delete(id)
          return { name: g.name, memberIds: members }
        })
        setSnapshot({ roles, userNameById, loading: false, error: null })
      } catch (err) {
        if (cancelled) return
        setSnapshot({
          roles: [],
          userNameById: new Map(),
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load roles.'
        })
      }
    })()
    return () => {
      cancelled = true
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [serverId])

  return snapshot
}
