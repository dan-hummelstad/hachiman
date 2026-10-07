import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { ChatMessage } from '@/stores/messagesStore'

/**
 * The pinned messages of each channel (N13), decrypted by the normal path (message-decrypt.ts)
 * but kept apart from the transcript. Written only by services/PinsService.ts.
 */
interface PinsState {
  /** channelId → the pinned message ids, newest pin first. Absent: not loaded. */
  order: Map<string, string[]>
  /** channelId → the decrypted rows of the pins, in `order`. */
  byChannel: Map<string, ChatMessage[]>
  setOrder: (channelId: string, ids: string[]) => void
  /** Rows from the decryptor (also later retries). Rows that are not in `order` are dropped. */
  upsertRows: (channelId: string, rows: ChatMessage[]) => void
}

const initialPinsState = (): Pick<PinsState, 'order' | 'byChannel'> => ({
  order: new Map(),
  byChannel: new Map()
})

export const usePinsStore = create<PinsState>()(
  devtools((set) => ({
    ...initialPinsState(),
    setOrder: (channelId, ids) =>
      set((s) => {
        const old = new Map((s.byChannel.get(channelId) ?? []).map((m) => [m.id, m]))
        const rows = ids.flatMap((id) => old.get(id) ?? [])
        return {
          order: new Map(s.order).set(channelId, ids),
          byChannel: new Map(s.byChannel).set(channelId, rows)
        }
      }),
    upsertRows: (channelId, incoming) =>
      set((s) => {
        const ids = s.order.get(channelId)
        if (!ids) return {}
        const byId = new Map((s.byChannel.get(channelId) ?? []).map((m) => [m.id, m]))
        for (const m of incoming) byId.set(m.id, m)
        const rows = ids.flatMap((id) => byId.get(id) ?? [])
        return { byChannel: new Map(s.byChannel).set(channelId, rows) }
      })
  }))
)

const EMPTY_PINS: ChatMessage[] = []

/** The decrypted pinned messages of a channel, newest pin first. */
export function usePins(channelId: string): ChatMessage[] {
  return usePinsStore((s) => s.byChannel.get(channelId) ?? EMPTY_PINS)
}

/** The pin count of a channel, or null before the pins are loaded. */
export function usePinCount(channelId: string): number | null {
  return usePinsStore((s) => s.order.get(channelId)?.length ?? null)
}

export function usePinned(channelId: string, messageId: string): boolean {
  return usePinsStore((s) => s.order.get(channelId)?.includes(messageId) ?? false)
}

export function resetPinsStore(): void {
  usePinsStore.setState(initialPinsState())
}
