import { useEffect } from 'react'
import type { MembershipEvent } from '@hachiman/crypto'
import { cryptoService } from '@/services/CryptoService'
import { addMembership, useCryptoStore } from '@/stores/cryptoStore'

const EMPTY_EVENTS: MembershipEvent[] = []
/** How many past events a channel loads from the Worker. */
const TIMELINE_LIMIT = 50

/**
 * The group membership changes of a channel, from the MLS commits that this device processed
 * (§12.16: "A added B"). Loads the stored timeline once the Worker is ready; live events come
 * through cryptoStore.
 */
export function useMembershipTimeline(channelId: string): MembershipEvent[] {
  const events = useCryptoStore((s) => s.membership.get(channelId) ?? EMPTY_EVENTS)
  const ready = useCryptoStore((s) => s.phase === 'ready' && s.status?.state === 'ready')

  useEffect(() => {
    if (!ready) return
    let live = true
    cryptoService
      .client()
      .membershipTimeline(channelId, TIMELINE_LIMIT)
      .then((loaded) => live && addMembership(channelId, loaded))
      .catch((e: unknown) => console.warn('[crypto] membership timeline failed', e))
    return () => {
      live = false
    }
  }, [channelId, ready])

  return events
}
