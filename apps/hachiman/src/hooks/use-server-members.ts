import { useEffect, useState } from 'react'
import { serversService } from '@/services/ServersService'
import type { IMumbleService, MumbleEvents } from '@/shared/IMumbleService'

/**
 * One row per Mumble user currently visible on the server. Carries the
 * fields the UI needs across both the right-side member list and the
 * voice-channel-inline member rows.
 */
export interface ServerMember {
  session: number
  /** Stable registered userId (Mumble's own), or undefined for guests. */
  userId: number | undefined
  name: string
  channelId: number
  selfMute: boolean
  selfDeaf: boolean
  /** Server-set when the session is bound to an Oracle account. */
  verified: boolean
  /** Display handle from Oracle (e.g. `@alice`); may differ from the Mumble nick. */
  oracleHandle?: string
}

/**
 * Subscribes to user lifecycle events on the connected Mumble service for
 * `serverId` and returns the full member list. Returns an empty array when
 * there's no connected service (e.g. between disconnect and reconnect, or
 * for a server that's never been opened).
 *
 * Implemented as one hook instead of separate per-channel queries because
 * the underlying event handlers are O(1) per Mumble message and consumers
 * typically need either the full list (right-side member list) or a slice
 * by channel — both cheap to derive once we have the array.
 */
export function useServerMembers(serverId: string | null): ServerMember[] {
  const [members, setMembers] = useState<ServerMember[]>([])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!serverId) {
      setMembers([])
      return
    }
    const service = serversService.getServer(serverId)
    if (!service) {
      setMembers([])
      return
    }
    const refresh = (): void => setMembers(collectMembers(service))
    refresh()
    const onChange: MumbleEvents['userUpdate'] = () => refresh()
    const onCreate: MumbleEvents['userCreate'] = () => refresh()
    const onRemove: MumbleEvents['userRemove'] = () => refresh()
    service.on('userUpdate', onChange)
    service.on('userCreate', onCreate)
    service.on('userRemove', onRemove)
    return () => {
      service.off('userUpdate', onChange)
      service.off('userCreate', onCreate)
      service.off('userRemove', onRemove)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [serverId])

  return members
}

function collectMembers(service: IMumbleService): ServerMember[] {
  return service.users
    .map((u) => {
      // `verified` and `oracleHandle` are added to the User shape by Agent A.
      // Until that lands the cast keeps the call-site honest about the contract.
      const oracleish = u as unknown as { verified?: boolean; oracleHandle?: string }
      return {
        session: u.session,
        userId: u.userId,
        name: u.name ?? `user-${u.session}`,
        channelId: u.channelId,
        selfMute: u.selfMute ?? false,
        selfDeaf: u.selfDeaf ?? false,
        verified: oracleish.verified === true,
        oracleHandle: oracleish.oracleHandle
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
