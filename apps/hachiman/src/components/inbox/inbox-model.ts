/**
 * Pure view models of the inbox (N8): the mentions list and the unread channels by guild. The
 * popover feeds them from unreadStore, messagesStore, channelStore, guildStore and prefsStore.
 * The inbox screen of the mobile layout (M67) puts both in one list (`inboxEntries`).
 */
import type { Channel, Guild } from '@hachiman/client'
import { compareChannels } from '@/lib/model'
import {
  isMuted,
  notifyLevel,
  visibleBadge,
  type NotifyPrefs,
  type UnreadBadge
} from '@/lib/notify'
import type { ChatMessage } from '@/stores/messagesStore'
import type { ChannelUnread } from '@/stores/unreadStore'

export interface MentionEntry {
  channelId: string
  messageId: string
  /** The decrypted row, when the transcript of the channel has it loaded. */
  row: ChatMessage | undefined
}

/**
 * Every mention of a channel that still exists, newest first. Rows that are loaded sort by their
 * time; the rest follow, newest mention id of each channel first.
 */
export function mentionEntries(
  unread: ReadonlyMap<string, ChannelUnread>,
  messages: ReadonlyMap<string, readonly ChatMessage[]>,
  channels: ReadonlyMap<string, Channel>
): MentionEntry[] {
  const loaded: MentionEntry[] = []
  const rest: MentionEntry[] = []
  for (const [channelId, c] of unread) {
    if (!channels.has(channelId) || c.mentionIds.length === 0) continue
    const rows = messages.get(channelId)
    for (let i = c.mentionIds.length - 1; i >= 0; i--) {
      const messageId = c.mentionIds[i]
      const row = rows?.find((m) => m.id === messageId)
      ;(row ? loaded : rest).push({ channelId, messageId, row })
    }
  }
  loaded.sort((a, b) => b.row!.createdAt.localeCompare(a.row!.createdAt))
  return [...loaded, ...rest]
}

export interface UnreadChannel {
  channel: Channel
  badge: UnreadBadge
  /** The new messages from others (raw, with no notification level applied). */
  unread: number
}

export interface UnreadGroup {
  /** null: the DMs. */
  guildId: string | null
  name: string
  channels: UnreadChannel[]
}

/**
 * The channels with a visible badge (notification level and mute applied), grouped by guild:
 * DMs first, then guilds by name. Channels keep the sidebar order.
 */
export function unreadGroups(
  unread: ReadonlyMap<string, ChannelUnread>,
  channels: ReadonlyMap<string, Channel>,
  guilds: ReadonlyMap<string, Pick<Guild, 'name'>>,
  prefs: NotifyPrefs
): UnreadGroup[] {
  const groups = new Map<string | null, UnreadGroup>()
  for (const [id, counts] of unread) {
    const channel = channels.get(id)
    if (!channel) continue
    const guildId = channel.guildId
    if (guildId !== null && !guilds.has(guildId)) continue
    const badge = visibleBadge(counts, notifyLevel(prefs, id, guildId), isMuted(prefs, id, guildId))
    if (!badge.unread && badge.mentions === 0) continue
    let g = groups.get(guildId)
    if (!g) {
      g = {
        guildId,
        name: guildId === null ? 'Direct messages' : guilds.get(guildId)!.name,
        channels: []
      }
      groups.set(guildId, g)
    }
    g.channels.push({ channel, badge, unread: counts.unread })
  }
  for (const g of groups.values()) g.channels.sort((a, b) => compareChannels(a.channel, b.channel))
  return [...groups.values()].sort(
    (a, b) =>
      (a.guildId === null ? 0 : 1) - (b.guildId === null ? 0 : 1) || a.name.localeCompare(b.name)
  )
}

/** What an entry of the inbox screen is: a message that mentions me, or a channel with news. */
export type InboxKind = 'mention' | 'channel'

/** The filter chips of the inbox screen: All, Mentions, Channels (the popover's Unread tab). */
export type InboxFilter = 'all' | 'mentions' | 'channels'

interface InboxEntryBase {
  /** Unique in the list. */
  key: string
  /** The time (ms) that sorts the entry: the message time, or the channel's last activity. */
  at: number | null
}

export type InboxEntry =
  | (InboxEntryBase & MentionEntry & { kind: 'mention' })
  | (InboxEntryBase & UnreadChannel & { kind: 'channel' })

const timeOf = (ms: number | undefined): number | null =>
  ms === undefined || Number.isNaN(ms) ? null : ms

/**
 * The mentions and the unread channels as one list, newest first: a mention by its message time,
 * a channel by its last activity (`lastAt`). Entries with no time follow in their given order. On
 * a tie the mention comes before its channel.
 */
export function inboxEntries(
  mentions: readonly MentionEntry[],
  channels: readonly UnreadChannel[],
  lastAt: ReadonlyMap<string, number>
): InboxEntry[] {
  const entries: InboxEntry[] = [
    ...mentions.map((m): InboxEntry => ({
      ...m,
      kind: 'mention',
      key: `mention:${m.messageId}`,
      at: timeOf(m.row && Date.parse(m.row.createdAt))
    })),
    ...channels.map((c): InboxEntry => ({
      ...c,
      kind: 'channel',
      key: `channel:${c.channel.id}`,
      at: timeOf(lastAt.get(c.channel.id))
    }))
  ]
  const timed = entries.filter((e) => e.at !== null).sort((a, b) => b.at! - a.at!)
  return [...timed, ...entries.filter((e) => e.at === null)]
}

/**
 * The entries that `filter` shows. All leaves out a channel when the mentions in the list already
 * cover its news: its badge shows mentions only (a muted channel), or it has no more new messages
 * than listed mentions.
 */
export function filterInbox(entries: readonly InboxEntry[], filter: InboxFilter): InboxEntry[] {
  if (filter === 'mentions') return entries.filter((e) => e.kind === 'mention')
  if (filter === 'channels') return entries.filter((e) => e.kind === 'channel')
  const listed = new Map<string, number>()
  for (const e of entries)
    if (e.kind === 'mention') listed.set(e.channelId, (listed.get(e.channelId) ?? 0) + 1)
  return entries.filter(
    (e) => e.kind === 'mention' || (e.badge.unread && e.unread > (listed.get(e.channel.id) ?? 0))
  )
}

export function inboxCounts(entries: readonly InboxEntry[]): Record<InboxFilter, number> {
  let mentions = 0
  for (const e of entries) if (e.kind === 'mention') mentions++
  return {
    all: filterInbox(entries, 'all').length,
    mentions,
    channels: entries.length - mentions
  }
}
