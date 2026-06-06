import type { PersistedMessage } from '@hachiman/hachiman-node'
import { serversService } from './ServersService'
import { useServerStore } from '@/stores/serverStore'
import { type HistoricMessage, useMessageStore, type Message } from '@/stores/messagesStore'
import type { IMumbleService } from '@/shared/IMumbleService'

/**
 * Resolve the IMumbleService for the currently selected server. We use the
 * selected server (rather than threading a server URL through the component
 * tree) because the chat view always operates against the active server.
 */
function resolveActiveMumbleService(): IMumbleService {
  const { selectedServerId } = useServerStore.getState()
  if (!selectedServerId) {
    throw new Error('No server is selected')
  }
  const mumble = serversService.getServer(selectedServerId)
  if (!mumble || !mumble.isConnected()) {
    throw new Error(`Server with url ${selectedServerId} is not connected`)
  }
  return mumble
}

function toHistoricMessage(p: PersistedMessage): HistoricMessage | null {
  if (p.id === undefined) {
    // Server-issued ids are required for dedup; skip malformed rows.
    return null
  }
  const createdAt = p.createdAtMs !== undefined ? new Date(Number(p.createdAtMs)) : new Date()
  return {
    id: p.id,
    author: p.actorName ?? p.actorSession?.toString() ?? 'Unknown',
    avatar: '',
    content: p.message ?? '',
    date: createdAt,
    // Carry the session through so prependHistory can dedup live UUID
    // entries against their canonical persisted form (see
    // stores/messagesStore.ts prependHistory).
    actorSession: p.actorSession
  }
}

function toRendererMessage(h: HistoricMessage): Message {
  return {
    id: h.id.toString(),
    author: h.author,
    avatar: h.avatar,
    content: h.content,
    date: h.date
  }
}

export const messagesService = {
  /**
   * Fetch a page of persisted history for a channel and merge it into the
   * message store. Returns the page plus `hasMore` so the UI can decide
   * whether to keep offering "load more".
   *
   * The server returns messages newest-first; we keep them in newest-first
   * shape for the return value (so the caller's `oldest = messages[0]`
   * cursor logic still works) and let the store re-sort ascending on merge.
   */
  async loadHistory(
    channelId: number,
    opts?: { beforeId?: bigint; limit?: number }
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    const mumble = resolveActiveMumbleService()

    const req: { channelId: number; beforeId?: bigint; limit?: number } = {
      channelId
    }
    if (opts?.beforeId !== undefined) req.beforeId = opts.beforeId
    if (opts?.limit !== undefined) req.limit = opts.limit

    const { messages: persisted, hasMore } = await mumble.fetchChannelMessages(req)

    const historic = persisted
      .map(toHistoricMessage)
      .filter((m): m is HistoricMessage => m !== null)

    if (historic.length > 0) {
      useMessageStore.getState().prependHistory(channelId, historic)
    }

    return {
      messages: historic.map(toRendererMessage),
      hasMore
    }
  }
}
