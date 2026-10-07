/**
 * Read state and unread counts (N7). Fed by services/hachiman.ts: READY, MESSAGE_CREATE (after
 * the decrypt), READ_STATE_UPDATE and channel or guild removals. The UI calls `markRead`.
 */
import type { GatewayEvents, Message } from '@hachiman/client'
import { messageMentionsMe } from '@/lib/mentions'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/hachiman'
import { rowFor, toEncrypted } from '@/services/message-decrypt'
import { mentionPass } from '@/services/unread-pass'
import type { ChatMessage } from '@/stores/messagesStore'
import { selectedChannelId, useNavStore } from '@/stores/navStore'
import {
  addMentions,
  addUnread,
  fromReadStates,
  keepChannels,
  markReadTo,
  resetUnreadStore,
  useUnreadStore,
  type ChannelUnread
} from '@/stores/unreadStore'

const ACK_DEBOUNCE_MS = 1_000

/** channelId → the pending ack: the message id and its timer. */
const acks = new Map<string, { messageId: string; timer: ReturnType<typeof setTimeout> }>()
/** The restart pass waits for the crypto Worker. */
let passWaiting = false
/** Bumped by READY and sign-out, so a pass of an older session does not write. */
let session = 0

const viewing = (channelId: string): boolean =>
  selectedChannelId() === channelId && typeof document !== 'undefined' && document.hasFocus()

function myRoles(guildId: string | null): string[] {
  const me = hachiman.cache.user
  if (!me || !guildId) return []
  return hachiman.cache.members.get(guildId)?.get(me.id)?.roles ?? []
}

/** Whether a decrypted row is from someone else and mentions me. */
function mentionsMe(row: ChatMessage): boolean {
  const me = hachiman.cache.user
  return !!me && row.author.id !== me.id && messageMentionsMe(row, me, myRoles(row.guildId))
}

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
  /** Once, from startHachiman. */
  start(): void {
    if (started) return
    started = true
    useNavStore.subscribe(snapshotOpened)
  },

  /** READY: the server's read states, then the mention pass. */
  onReady(): void {
    session++
    useUnreadStore.setState({
      byChannel: fromReadStates([...hachiman.cache.readStates.values()]),
      opened: null
    })
    snapshotOpened()
    void runPass()
  },

  /** The crypto Worker became ready: a pass that waited for it runs now. */
  onCryptoReady(): void {
    if (passWaiting) void runPass()
  },

  /**
   * MESSAGE_CREATE. `row` is the decrypted row (undefined when it did not decrypt). A message from
   * someone else counts unless its channel is open and the window has focus.
   */
  onMessageCreate(m: Message, row: ChatMessage | undefined): void {
    const me = hachiman.cache.user
    if (!me || m.author.id === me.id || viewing(m.channelId)) return
    const mentioned = row?.decrypt.status === 'ok' && mentionsMe(row)
    useUnreadStore.setState((s) => {
      const byChannel = addUnread(s.byChannel, m.channelId)
      return { byChannel: mentioned ? addMentions(byChannel, m.channelId, [m.id]) : byChannel }
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

  /** Sign-out. */
  reset(): void {
    session++
    passWaiting = false
    for (const { timer } of acks.values()) clearTimeout(timer)
    acks.clear()
    resetUnreadStore()
  }
}
