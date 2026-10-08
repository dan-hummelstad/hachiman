/**
 * Poke (contract §4 Poke): POST /users/:id/poke, and the POKE event to my sessions, which shows
 * a toast with "Poke back" and plays the poke sound. A poke has no content, so it has no envelope.
 */
import type { GatewayDispatch, User } from '@hachiman/client'
import { hachiman } from '@/services/client'
import type { ClientFeature } from '@/services/features'
import { playSound } from '@/services/SoundService'
import { usePokeStore } from '@/stores/pokeStore'

/** A toast stays this long. */
export const POKE_TOAST_MS = 8_000

export const pokeService = {
  /** Rejects with the REST error (403 Blocked, 404, 429 RateLimited). */
  poke: (userId: string): Promise<void> => hachiman.rest.poke(userId),
  dismiss: (id: number): void => usePokeStore.getState().remove(id)
}

let nextId = 1

/** Shows the toast unless I blocked the sender (the server refuses a poke across a block too). */
export function receivePoke(user: User): void {
  if (hachiman.cache.blocks.has(user.id)) return
  const id = nextId++
  usePokeStore.getState().add({ id, user, at: Date.now() })
  playSound('poke')
  setTimeout(() => usePokeStore.getState().remove(id), POKE_TOAST_MS)
}

export const pokeFeature: ClientFeature = {
  name: 'poke',
  onDispatch(e: GatewayDispatch): void {
    if (e.t === 'POKE') receivePoke(e.d.user)
  },
  reset: () => usePokeStore.setState({ toasts: [] })
}
