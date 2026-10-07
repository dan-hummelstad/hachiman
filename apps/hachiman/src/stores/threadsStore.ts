import type {} from '@redux-devtools/extension'
import { useMemo } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { devtools } from 'zustand/middleware'
import type { Channel } from '@hachiman/client'
import { useChannelStore } from '@/stores/channelStore'
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'

/**
 * Thread activity order (N12). The thread channels themselves are in channelStore (type
 * 'thread', `parentId`). Message ids are random UUIDs, so the activity order comes from
 * GET /channels/:id/threads (newest activity first) and from the loaded messages.
 */
interface ThreadsState {
  /** parentId → thread ids, newest activity first, from the last list call. */
  order: Map<string, string[]>
  setOrder: (parentId: string, ids: string[]) => void
}

export const useThreadsStore = create<ThreadsState>()(
  devtools((set) => ({
    order: new Map(),
    setOrder: (parentId, ids) => set((s) => ({ order: new Map(s.order).set(parentId, ids) }))
  }))
)

export function resetThreadsStore(): void {
  useThreadsStore.setState({ order: new Map() })
}

const isThreadOf = (c: Channel, parentId: string): boolean =>
  c.type === 'thread' && c.parentId === parentId

/** The number of known threads under a channel. */
export function threadCount(channels: ReadonlyMap<string, Channel>, parentId: string): number {
  let n = 0
  for (const c of channels.values()) if (isThreadOf(c, parentId)) n++
  return n
}

/** The createdAt of the newest loaded message of a channel, or null. */
export function lastActivityOf(
  byChannel: ReadonlyMap<string, readonly ChatMessage[]>,
  channelId: string
): string | null {
  const list = byChannel.get(channelId)
  return list && list.length > 0 ? list[list.length - 1].createdAt : null
}

/**
 * The threads under `parentId`, newest activity first: a thread with loaded messages by its
 * newest message, then the rest in the order of the last list call, then by name.
 */
export function threadsOf(
  channels: ReadonlyMap<string, Channel>,
  parentId: string,
  lastActivity: (threadId: string) => string | null,
  order: readonly string[] = []
): Channel[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  const threads = [...channels.values()].filter((c) => isThreadOf(c, parentId))
  const at = new Map(threads.map((t) => [t.id, lastActivity(t.id)]))
  return threads.sort((a, b) => {
    const x = at.get(a.id) ?? null
    const y = at.get(b.id) ?? null
    if (x !== y) {
      if (x === null) return 1
      if (y === null) return -1
      return y.localeCompare(x)
    }
    const ra = rank.get(a.id) ?? Infinity
    const rb = rank.get(b.id) ?? Infinity
    if (ra !== rb) return ra - rb
    return (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id)
  })
}

const EMPTY_ORDER: string[] = []

/** The threads under a channel, newest activity first. */
export function useThreads(parentId: string): Channel[] {
  const channels = useChannelStore((s) => s.channels)
  const ids = useMemo(
    () => [...channels.values()].filter((c) => isThreadOf(c, parentId)).map((c) => c.id),
    [channels, parentId]
  )
  // Only the last activity of these threads: a message in another channel does not re-sort.
  const activity = useMessageStore(
    useShallow((s) => ids.map((id) => lastActivityOf(s.byChannel, id)))
  )
  const order = useThreadsStore((s) => s.order.get(parentId) ?? EMPTY_ORDER)
  return useMemo(() => {
    const at = new Map(ids.map((id, i) => [id, activity[i] ?? null]))
    return threadsOf(channels, parentId, (id) => at.get(id) ?? null, order)
  }, [channels, ids, activity, order, parentId])
}

export function useThreadCount(parentId: string): number {
  return useChannelStore((s) => threadCount(s.channels, parentId))
}
