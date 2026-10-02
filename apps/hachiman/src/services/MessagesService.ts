import type { Attachment } from '@hachiman/client'
import { hachiman } from '@/services/hachiman'
import { messagesEpoch, useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import { useUserStore } from '@/stores/userStore'

const PAGE_SIZE = 50
const TYPING_THROTTLE_MS = 8_000

let lastTyping = { channelId: '', at: 0 }
/** channelId → the history page request in flight, so overlapping triggers share one fetch. */
const loading = new Map<string, Promise<void>>()

async function fetchOlder(channelId: string): Promise<void> {
  const store = useMessageStore.getState()
  const startedIn = messagesEpoch()
  const oldest = store.byChannel.get(channelId)?.find((m) => !m.pending)
  const page = await hachiman.rest.getMessages(channelId, {
    before: store.hasMore.has(channelId) ? oldest?.id : undefined,
    limit: PAGE_SIZE
  })
  if (messagesEpoch() !== startedIn) return // signed out meanwhile
  store.upsert(channelId, page)
  store.setHasMore(channelId, page.length === PAGE_SIZE)
}

export const messagesService = {
  /**
   * Load the page before the oldest loaded message (or the latest page on first load). No-op once
   * history is exhausted; joins the in-flight request if one is running. Never rejects (logs).
   */
  loadOlder(channelId: string): Promise<void> {
    const running = loading.get(channelId)
    if (running) return running
    if (useMessageStore.getState().hasMore.get(channelId) === false) return Promise.resolve()
    const request = fetchOlder(channelId)
      .catch((e) => console.warn('[messages] history failed', e))
      .finally(() => loading.delete(channelId))
    loading.set(channelId, request)
    return request
  },

  /** Load the latest page unless this channel's history was already loaded. */
  ensureLoaded(channelId: string): void {
    if (!useMessageStore.getState().hasMore.has(channelId))
      void messagesService.loadOlder(channelId)
  },

  /**
   * Optimistic send: a pending row keyed by nonce, replaced by the echo (REST response or
   * MESSAGE_CREATE). `attachments` are finished uploads; the pending row renders them already.
   */
  async send(channelId: string, content: string, attachments: Attachment[] = []): Promise<void> {
    const text = content.trim()
    const me = useUserStore.getState().me
    if ((!text && attachments.length === 0) || !me) return
    const nonce = crypto.randomUUID()
    const store = useMessageStore.getState()
    store.addPending({
      id: nonce,
      nonce,
      channelId,
      guildId: hachiman.cache.channels.get(channelId)?.guildId ?? null,
      author: me,
      content: text,
      attachments,
      createdAt: new Date().toISOString(),
      editedAt: null,
      pending: true
    })
    lastTyping = { channelId: '', at: 0 }
    try {
      store.upsert(channelId, [
        await hachiman.rest.sendMessage(channelId, {
          content: text,
          nonce,
          attachments: attachments.length > 0 ? attachments.map((a) => a.id) : undefined
        })
      ])
    } catch (err) {
      console.error('[messages] send failed', err)
      store.markFailed(channelId, nonce)
    }
  },

  /**
   * Re-send a failed optimistic message: drop its row, send it as a fresh pending one. Its uploads
   * were never claimed, so their ids are still good.
   */
  async retry(message: ChatMessage): Promise<void> {
    messagesService.discard(message)
    await messagesService.send(message.channelId, message.content, message.attachments)
  },

  /** Drop a failed optimistic message locally (it never reached the server). */
  discard(message: ChatMessage): void {
    useMessageStore.getState().remove(message.channelId, message.id)
  },

  /** Text only: attachments never change. '' is valid only for a message with attachments. */
  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    const text = content.trim()
    const updated = await hachiman.rest.editMessage(channelId, messageId, { content: text })
    useMessageStore.getState().upsert(channelId, [updated])
  },

  async delete(channelId: string, messageId: string): Promise<void> {
    await hachiman.rest.deleteMessage(channelId, messageId)
    useMessageStore.getState().remove(channelId, messageId)
  },

  /** Throttled TYPING_START trigger; call on every keystroke. */
  typing(channelId: string): void {
    const now = Date.now()
    if (lastTyping.channelId === channelId && now - lastTyping.at < TYPING_THROTTLE_MS) return
    lastTyping = { channelId, at: now }
    void hachiman.rest.triggerTyping(channelId).catch(() => {})
  }
}
