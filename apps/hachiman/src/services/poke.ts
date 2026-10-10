/**
 * Poke (contract §4 Poke): POST /users/:id/poke, and the POKE event to my sessions, which shows
 * a toast with "Poke back" and plays the poke sound. A poke has no content, so it has no envelope.
 */
import { useCallback, useEffect, useState } from 'react'
import type { GatewayDispatch, User } from '@hachiman/client'
import { useAction } from '@/hooks/use-action'
import { hachiman } from '@/services/client'
import type { ClientFeature } from '@/services/features'
import { playSound } from '@/services/SoundService'
import { usePokeStore } from '@/stores/pokeStore'

export const POKE_TOAST_MS = 8_000
/** How long a poke button shows "Poke sent!" after a poke went out. */
export const POKE_SENT_MS = 2_000

export const pokeService = {
  /** Rejects with the REST error (403 Blocked, 404, 429 RateLimited). */
  poke: (userId: string): Promise<void> => hachiman.rest.poke(userId),
  dismiss: (id: number): void => usePokeStore.getState().remove(id)
}

/**
 * A poke button: `run` pokes `userId` and resolves true when it went out, else sets `error`.
 * `sent` is true for POKE_SENT_MS after a poke went out, for the "Poke sent!" label.
 */
export function usePoke(): {
  run: (userId: string, name: string) => Promise<boolean>
  busy: boolean
  sent: boolean
  error: string | null
} {
  const { run: runAction, busy, error } = useAction()
  const [sent, setSent] = useState(false)
  useEffect(() => {
    if (!sent) return
    const t = setTimeout(() => setSent(false), POKE_SENT_MS)
    return () => clearTimeout(t)
  }, [sent])
  const run = useCallback(
    async (userId: string, name: string) => {
      const { ok } = await runAction(`poke ${name}`, () => pokeService.poke(userId))
      if (ok) setSent(true)
      return ok
    },
    [runAction]
  )
  return { run, busy, sent, error }
}

let nextId = 1

/** Shows the toast unless I blocked the sender (the server refuses a poke across a block too). */
export function receivePoke(user: User): void {
  if (hachiman.cache.blocks.has(user.id)) return
  const id = nextId++
  usePokeStore.getState().add({ id, user })
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
