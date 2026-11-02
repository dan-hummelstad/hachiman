import { useEffect, useRef, useState } from 'react'
import type { GatewayState } from '@hachiman/client'
import { useUserStore } from '@/stores/userStore'

/**
 * The connection counts as lost once the gateway was ready in this session and is now reconnecting
 * or closed. Before the first READY it is a start-up, not a loss.
 */
export function connectionLost(prevSeenReady: boolean, state: GatewayState): boolean {
  return prevSeenReady && (state === 'connecting' || state === 'resuming' || state === 'closed')
}

/** The time label of the banners: "14:05" in the user's locale. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Whether the connection is lost now, and since when (the moment it left `ready`). */
export function useConnectionLoss(): { lost: boolean; since: number | null } {
  const state = useUserStore((s) => s.gatewayState)
  const seenReady = useRef(false)
  const [since, setSince] = useState<number | null>(null)

  if (state === 'ready') seenReady.current = true
  const lost = connectionLost(seenReady.current, state)

  useEffect(() => {
    setSince((prev) => (lost ? (prev ?? Date.now()) : null))
  }, [lost])

  return { lost, since }
}
