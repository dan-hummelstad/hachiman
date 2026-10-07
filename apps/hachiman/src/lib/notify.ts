/** N9 notification levels. Stored per account in prefsStore; read by sounds and unread badges. */
export type NotifyLevel = 'all' | 'mentions' | 'none'

export interface NotifyPrefs {
  /** channelId or guildId → level. A channel level wins over its guild level. */
  notify: Readonly<Record<string, NotifyLevel>>
  /** Muted channel and guild ids: no unread pip and no sound for plain messages. */
  muted: readonly string[]
}

/** The level of a guild: its own, else the default for guild channels ('mentions'). */
export function guildNotifyLevel(p: NotifyPrefs, guildId: string): NotifyLevel {
  return p.notify[guildId] ?? 'mentions'
}

/** The level of a channel: its own, else its guild's, else the default (DMs: all, guilds: mentions). */
export function notifyLevel(
  p: NotifyPrefs,
  channelId: string,
  guildId: string | null
): NotifyLevel {
  return p.notify[channelId] ?? (guildId === null ? 'all' : guildNotifyLevel(p, guildId))
}

/**
 * "Following" a read-only channel (B7): the channel itself is set to all messages. A guild level
 * of 'all' alone is not following, so "Follow" sets the channel and "Following" can undo it.
 */
export function isFollowing(p: NotifyPrefs, channelId: string): boolean {
  return p.notify[channelId] === 'all'
}

export function isMuted(p: NotifyPrefs, channelId: string, guildId: string | null): boolean {
  return p.muted.includes(channelId) || (guildId !== null && p.muted.includes(guildId))
}

/** Whether a new message from someone else pings (sound, later a desktop notification). */
export function shouldPing(level: NotifyLevel, muted: boolean, mentioned: boolean): boolean {
  if (level === 'none') return false
  if (mentioned) return true
  return level === 'all' && !muted
}

/** What a badge shows for one channel: the unread pip and the mention count. */
export interface UnreadBadge {
  unread: boolean
  mentions: number
}

/** 'none' shows nothing; muted hides the pip but keeps the mention count. */
export function visibleBadge(
  counts: { unread: number; mentions: number } | undefined,
  level: NotifyLevel,
  muted: boolean
): UnreadBadge {
  if (!counts || level === 'none') return { unread: false, mentions: 0 }
  return { unread: !muted && counts.unread > 0, mentions: counts.mentions }
}
