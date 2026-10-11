/**
 * Read state and unread counts (N7). A client feature (services/features.ts): READY, MESSAGE_CREATE
 * (after the decrypt), READ_STATE_UPDATE and channel or guild removals. The UI calls `markRead`,
 * `markChannelRead` and `markAllRead`.
 */
import type { GatewayDispatch, GatewayEvents, Message } from '@hachiman/client'
import { isMuted, notifyLevel, visibleBadge } from '@/lib/notify'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/client'
import type { ClientFeature } from '@/services/features'
import { mentionsMe, type MessageContext } from '@/services/message-context'
import { rowFor, toEncrypted } from '@/services/message-decrypt'
import { mentionPass } from '@/services/unread-pass'
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import { selectedChannelId, useNavStore } from '@/stores/navStore'
import { notifyPrefs } from '@/stores/prefsStore'
import {
  addMentions,
  addUnread,
  bumpLastAt,
  clearCounts,
  fromReadStates,
  keepChannels,
  lastAtFromReadStates,
  markReadTo,
  resetUnreadStore,
  useUnreadStore,
  type ChannelUnread
} from '@/stores/unreadStore'

const ACK_DEBOUNCE_MS = 1_000

/** channelId → the pending ack: the message id and its timer. */
const acks = new Map<string, { messageId: string; timer: ReturnType<typeof setTimeout> }>()
/**
 * channelId → the newest message id and its time (ms): READY `lastMessageId`, then each
 * MESSAGE_CREATE. "Mark read" acks it for a channel with no loaded messages.
 */
const newest = new Map<string, { id: string; at: number }>()
/** The restart pass waits for the crypto Worker. */
let passWaiting = false
/** Bumped by READY and sign-out, so a pass of an older session does not write. */
let session = 0

const historyOrder = (a: Message, b: Message): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

/** Decrypts for counting only: nothing goes into messagesStore. */
async function decryptForCount(messages: Message[]): Promise<ChatMessage[]> {
  const results = await cryptoService.client().decryptMessages(messages.map(toEncrypted))
  const byId = new Map(results.map((r) => [r.messageId, r]))
  const rows: ChatMessage[] = []
  for (const m of messages) {
    const r = byId.get(m.id)
    const row = r ? rowFor(m, r, undefined) : null
    if (row?.decrypt.status === 'ok') rows.push(row)
  }
  return rows
}

/** DMs first, then the most unread: the server gives no message times to order by. */
function passOrder(): [string, ChannelUnread][] {
  const channels = hachiman.cache.channels
  const isDm = (id: string): number => (channels.get(id)?.guildId === null ? 0 : 1)
  return [...useUnreadStore.getState().byChannel].sort(
    ([a, x], [b, y]) => isDm(a) - isDm(b) || y.unread - x.unread
  )
}

async function runPass(): Promise<void> {
  try {
    cryptoService.client()
  } catch {
    passWaiting = true // not ready: onCryptoReady runs it
    return
  }
  passWaiting = false
  const started = session
  const found = await mentionPass(passOrder(), {
    fetchLatest: async (channelId, limit) =>
      (await hachiman.rest.getMessages(channelId, { limit })).sort(historyOrder),
    decrypt: decryptForCount,
    mentionsMe
  })
  if (started !== session) return
  useUnreadStore.setState((s) => {
    let byChannel = s.byChannel
    for (const [channelId, ids] of found) byChannel = addMentions(byChannel, channelId, ids)
    return { byChannel }
  })
}

/** The read state of the open channel, kept for its NEW divider until another channel opens. */
function snapshotOpened(): void {
  const channelId = selectedChannelId()
  if (useUnreadStore.getState().opened?.channelId === channelId) return
  const c = channelId ? useUnreadStore.getState().byChannel.get(channelId) : undefined
  useUnreadStore.setState({
    opened: channelId
      ? { channelId, lastReadId: c?.lastReadId ?? null, unread: c?.unread ?? 0 }
      : null
  })
}

let started = false

export const unreadService = {
  /** Idempotent: the NEW divider follows the open channel. */
  start(): void {
    if (started) return
    started = true
    useNavStore.subscribe(snapshotOpened)
  },

  /** READY: the server's read states, then the mention pass. */
  onReady(): void {
    unreadService.start()
    session++
    const readStates = [...hachiman.cache.readStates.values()]
    newest.clear()
    for (const r of readStates) {
      const at = r.lastMessageAt ? Date.parse(r.lastMessageAt) : NaN
      if (r.lastMessageId) newest.set(r.channelId, { id: r.lastMessageId, at })
    }
    useUnreadStore.setState({
      byChannel: fromReadStates(readStates),
      opened: null,
      lastAt: lastAtFromReadStates(readStates)
    })
    snapshotOpened()
    void runPass()
  },

  /** The crypto Worker became ready: a pass that waited for it runs now. */
  onCryptoReady(): void {
    if (passWaiting) void runPass()
  },

  /**
   * MESSAGE_CREATE: the channel's last activity (the DM order). A notification (services/message-context.ts) counts unless its channel is open
   * and the window has focus.
   */
  onMessageCreate(m: Pick<Message, 'id' | 'channelId' | 'createdAt'>, ctx: MessageContext): void {
    const at = Date.parse(m.createdAt)
    const known = newest.get(m.channelId)
    if (!known || !(known.at > at)) newest.set(m.channelId, { id: m.id, at })
    useUnreadStore.setState((s) => ({
      lastAt: bumpLastAt(s.lastAt, m.channelId, Date.parse(m.createdAt))
    }))
    if (!ctx.isNotification || ctx.viewing) return
    useUnreadStore.setState((s) => {
      const byChannel = addUnread(s.byChannel, m.channelId)
      return {
        byChannel: ctx.mentionsMe ? addMentions(byChannel, m.channelId, [m.id]) : byChannel
      }
    })
  },

  /** Another session of mine acked (or this one: the echo). */
  onReadStateUpdate(d: GatewayEvents['READ_STATE_UPDATE']): void {
    useUnreadStore.setState((s) => ({
      byChannel: markReadTo(s.byChannel, d.channelId, d.lastReadMessageId)
    }))
  },

  /** Channel delete or guild left: drop their read states. */
  onChannelsChanged(): void {
    useUnreadStore.setState((s) => ({
      byChannel: keepChannels(s.byChannel, hachiman.cache.channels)
    }))
  },

  /**
   * Marks `channelId` read up to `messageId` now, and sends the ack after 1 s without a newer
   * call. The transcript calls it when the channel is open, the window has focus and the last
   * message is in view; the inbox calls it for "Mark read".
   */
  markRead(channelId: string, messageId: string): void {
    const c = useUnreadStore.getState().byChannel.get(channelId)
    const pending = acks.get(channelId)
    if (pending?.messageId === messageId) return
    if (!pending && c?.lastReadId === messageId && c.unread === 0 && c.mentions === 0) return
    useUnreadStore.setState((s) => ({ byChannel: markReadTo(s.byChannel, channelId, messageId) }))
    if (pending) clearTimeout(pending.timer)
    const timer = setTimeout(() => {
      acks.delete(channelId)
      void hachiman.rest
        .ackMessage(channelId, messageId)
        .catch((e: unknown) => console.warn('[unread] ack failed', e))
    }, ACK_DEBOUNCE_MS)
    acks.set(channelId, { messageId, timer })
  },

  /**
   * Acks the newest message of a channel: the loaded one, else the newest that READY or a
   * MESSAGE_CREATE named, else its newest mention. With no id at all the counts still clear here.
   */
  markChannelRead(channelId: string): void {
    const loaded = useMessageStore.getState().byChannel.get(channelId)
    const id =
      loaded?.findLast((m) => !m.pending && !m.failed)?.id ??
      newest.get(channelId)?.id ??
      hachiman.cache.readStates.get(channelId)?.lastMessageId ??
      useUnreadStore.getState().byChannel.get(channelId)?.mentionIds.at(-1)
    if (id) unreadService.markRead(channelId, id)
    else useUnreadStore.setState((s) => ({ byChannel: clearCounts(s.byChannel, channelId) }))
  },

  /**
   * "Mark all read" of the inbox screen (M67): `markChannelRead` for each channel with a visible
   * badge (its notification level and mute applied) or a mention in the inbox. Returns how many
   * channels it marked.
   */
  markAllRead(): number {
    const channels = hachiman.cache.channels
    const prefs = notifyPrefs()
    let marked = 0
    for (const [channelId, counts] of useUnreadStore.getState().byChannel) {
      const guildId = channels.get(channelId)?.guildId
      if (guildId === undefined) continue
      const badge = visibleBadge(
        counts,
        notifyLevel(prefs, channelId, guildId),
        isMuted(prefs, channelId, guildId)
      )
      if (!badge.unread && counts.mentions === 0) continue
      unreadService.markChannelRead(channelId)
      marked++
    }
    return marked
  },

  /** Sign-out. */
  reset(): void {
    session++
    passWaiting = false
    for (const { timer } of acks.values()) clearTimeout(timer)
    acks.clear()
    newest.clear()
    resetUnreadStore()
  }
}

export const unreadFeature: ClientFeature = {
  name: 'unread',
  onReady: () => unreadService.onReady(),
  onDispatch(e: GatewayDispatch): void {
    if (e.t === 'READ_STATE_UPDATE') unreadService.onReadStateUpdate(e.d)
    if (e.t === 'GUILD_DELETE' || e.t === 'CHANNEL_DELETE') unreadService.onChannelsChanged()
  },
  onMessage: (m, _row, ctx) => unreadService.onMessageCreate(m, ctx),
  onCryptoReady: () => unreadService.onCryptoReady(),
  reset: () => unreadService.reset()
}
