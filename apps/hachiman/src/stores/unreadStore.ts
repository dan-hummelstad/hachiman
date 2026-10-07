import type {} from '@redux-devtools/extension'
import { useMemo } from 'react'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'
import type { Channel, ReadState } from '@hachiman/client'
import {
  isMuted,
  notifyLevel,
  visibleBadge,
  type NotifyPrefs,
  type UnreadBadge
} from '@/lib/notify'
import { useChannelStore } from '@/stores/channelStore'
import type { ChatMessage } from '@/stores/messagesStore'
import { useMessageStore } from '@/stores/messagesStore'
import { useNotifyPrefs } from '@/stores/prefsStore'

/** The read state of one channel (N7). Counts are raw: notification levels apply when shown. */
export interface ChannelUnread {
  lastReadId: string | null
  /** Messages from others after `lastReadId`. */
  unread: number
  mentions: number
  /** The messages that mention me, oldest first (the inbox, N8). */
  mentionIds: string[]
}

/** The read state of the open channel when it opened: the NEW divider stays where it was. */
export interface OpenedSnapshot {
  channelId: string
  lastReadId: string | null
  unread: number
}

interface UnreadState {
  byChannel: Map<string, ChannelUnread>
  opened: OpenedSnapshot | null
}

const EMPTY: ChannelUnread = { lastReadId: null, unread: 0, mentions: 0, mentionIds: [] }
const EMPTY_IDS: string[] = []

const initialUnreadState = (): UnreadState => ({ byChannel: new Map(), opened: null })

export const useUnreadStore = create<UnreadState>()(devtools(initialUnreadState))

export function resetUnreadStore(): void {
  useUnreadStore.setState(initialUnreadState())
}

// The reducers: pure, so the tests run them without a store.

/**
 * READY: the server's counts. A channel never acked that has messages counts as unread (1): the
 * server does not count it.
 */
export function fromReadStates(readStates: readonly ReadState[]): Map<string, ChannelUnread> {
  const out = new Map<string, ChannelUnread>()
  for (const r of readStates) {
    const neverRead = r.lastReadMessageId === null && r.lastMessageId !== null
    const unread = neverRead ? Math.max(1, r.unreadCount) : r.unreadCount
    out.set(r.channelId, { ...EMPTY, lastReadId: r.lastReadMessageId, unread })
  }
  return out
}

function patch(
  m: Map<string, ChannelUnread>,
  channelId: string,
  f: (c: ChannelUnread) => ChannelUnread
): Map<string, ChannelUnread> {
  const before = m.get(channelId) ?? EMPTY
  const after = f(before)
  return after === before ? m : new Map(m).set(channelId, after)
}

/** MESSAGE_CREATE from someone else in a channel that is not open and focused. */
export const addUnread = (
  m: Map<string, ChannelUnread>,
  channelId: string
): Map<string, ChannelUnread> => patch(m, channelId, (c) => ({ ...c, unread: c.unread + 1 }))

/** A message that mentions me (live or from the restart pass). Counted once per message id. */
export const addMentions = (
  m: Map<string, ChannelUnread>,
  channelId: string,
  messageIds: readonly string[]
): Map<string, ChannelUnread> =>
  patch(m, channelId, (c) => {
    const fresh = messageIds.filter((id) => !c.mentionIds.includes(id))
    if (fresh.length === 0) return c
    const mentionIds = [...c.mentionIds, ...fresh]
    return { ...c, mentionIds, mentions: mentionIds.length }
  })

/** An ack (mine, or READ_STATE_UPDATE from another session): everything up to it is read. */
export const markReadTo = (
  m: Map<string, ChannelUnread>,
  channelId: string,
  lastReadId: string
): Map<string, ChannelUnread> =>
  patch(m, channelId, (c) =>
    c.lastReadId === lastReadId && c.unread === 0 && c.mentions === 0
      ? c
      : { lastReadId, unread: 0, mentions: 0, mentionIds: EMPTY_IDS }
  )

/** Keeps only the channels in `channels` (channel delete, guild left). */
export function keepChannels(
  m: Map<string, ChannelUnread>,
  channels: ReadonlyMap<string, unknown>
): Map<string, ChannelUnread> {
  if ([...m.keys()].every((id) => channels.has(id))) return m
  return new Map([...m].filter(([id]) => channels.has(id)))
}

/** The badge sum of the channels for which `pick` is true. */
export function sumBadges(
  byChannel: ReadonlyMap<string, ChannelUnread>,
  channels: ReadonlyMap<string, Channel>,
  prefs: NotifyPrefs,
  pick: (c: Channel) => boolean
): UnreadBadge {
  let unread = false
  let mentions = 0
  for (const [id, counts] of byChannel) {
    const c = channels.get(id)
    if (!c || !pick(c)) continue
    const b = visibleBadge(counts, notifyLevel(prefs, id, c.guildId), isMuted(prefs, id, c.guildId))
    unread ||= b.unread
    mentions += b.mentions
  }
  return { unread, mentions }
}

/**
 * The message the NEW divider goes above: the first one after the read point that the channel
 * had when it opened. With that message not loaded, the last `unread` rows are the unread ones.
 */
export function firstUnreadId(
  messages: readonly Pick<ChatMessage, 'id'>[],
  opened: Pick<OpenedSnapshot, 'lastReadId' | 'unread'> | null
): string | null {
  if (!opened || opened.unread === 0 || messages.length === 0) return null
  const at = opened.lastReadId === null ? -1 : messages.findIndex((m) => m.id === opened.lastReadId)
  if (at >= 0) return messages[at + 1]?.id ?? null
  return messages[Math.max(0, messages.length - opened.unread)].id
}

// Hooks. Each selector returns a stored reference or a primitive (CLAUDE.md selector rules).

/** The raw read state of one channel. */
export const useChannelReadState = (channelId: string | null): ChannelUnread =>
  useUnreadStore((s) => (channelId !== null ? (s.byChannel.get(channelId) ?? EMPTY) : EMPTY))

/** The mention message ids of one channel, oldest first. */
export const useMentionIds = (channelId: string): string[] =>
  useUnreadStore((s) => s.byChannel.get(channelId)?.mentionIds ?? EMPTY_IDS)

/** The badge of one channel or DM, with its notification level and mute applied. */
export function useChannelUnread(channelId: string): UnreadBadge {
  const prefs = useNotifyPrefs()
  const guildId = useChannelStore((s) => s.channels.get(channelId)?.guildId ?? null)
  const level = notifyLevel(prefs, channelId, guildId)
  const muted = isMuted(prefs, channelId, guildId)
  return useUnreadStore(useShallow((s) => visibleBadge(s.byChannel.get(channelId), level, muted)))
}

/** The badge sum of the channels of `guildId` (null = the DMs). */
function useBadgeSum(guildId: string | null): UnreadBadge {
  const prefs = useNotifyPrefs()
  const channels = useChannelStore((s) => s.channels)
  const byChannel = useUnreadStore((s) => s.byChannel)
  return useMemo(
    () => sumBadges(byChannel, channels, prefs, (c) => c.guildId === guildId),
    [byChannel, channels, prefs, guildId]
  )
}

/** A guild's dot and mention sum (the space bar). A muted guild shows no dot. */
export const useGuildUnread = (guildId: string): UnreadBadge => useBadgeSum(guildId)

/** All DMs together (the DM home in the space bar). */
export const useDmUnread = (): UnreadBadge => useBadgeSum(null)

/** Any mention anywhere (the inbox dot, N8). */
export const useAnyMention = (): boolean =>
  useUnreadStore((s) => [...s.byChannel.values()].some((c) => c.mentions > 0))

const EMPTY_MESSAGES: ChatMessage[] = []

/** The NEW divider of the open channel: the id of the first unread message, or null. */
export function useFirstUnreadId(channelId: string): string | null {
  const opened = useUnreadStore((s) => (s.opened?.channelId === channelId ? s.opened : null))
  const messages = useMessageStore((s) => s.byChannel.get(channelId) ?? EMPTY_MESSAGES)
  return useMemo(() => firstUnreadId(messages, opened), [messages, opened])
}
