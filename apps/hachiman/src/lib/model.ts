/**
 * Pure view-model helpers over the client's wire types. No React, no stores: everything here
 * takes plain data and returns plain data, so components and hooks share one implementation.
 */
import type {
  Channel,
  ChannelType,
  CreateChannelBody,
  Member,
  PresenceStatus,
  Role,
  User
} from '@hachiman/client'

const TYPE_ORDER: Record<Channel['type'], number> = {
  text: 0,
  pages: 0,
  voice: 1,
  category: 2,
  dm: 0,
  group_dm: 0,
  thread: 0
}

/** The channel types of the create dialog and the category menu, in this order. */
export const CREATE_CHANNEL_TYPES = ['text', 'voice', 'pages'] as const

/** How the create dialog and the category menu name each type that a member can create. */
export const CHANNEL_KINDS: Record<
  CreateChannelBody['type'],
  { label: string; hint: string; placeholder: string }
> = {
  text: { label: 'Text', hint: 'Send messages, links and code', placeholder: 'general' },
  voice: { label: 'Voice', hint: 'Talk together with voice', placeholder: 'Lounge' },
  pages: {
    label: 'Pages',
    hint: 'Write documents together, next to the chat',
    placeholder: 'design-pages'
  },
  category: { label: 'Category', hint: '', placeholder: 'Text' }
}

/**
 * A channel type with a message history: a new one opens at once, and the text permission bits
 * apply (in a pages channel VIEW_CHANNEL reads the pages, SEND_MESSAGES edits them).
 */
export const hasChat = (type: ChannelType): boolean => type === 'text' || type === 'pages'

const KIND_NAMES: Record<ChannelType, string> = {
  text: 'Text channel',
  voice: 'Voice channel',
  pages: 'Pages channel',
  category: 'Category',
  thread: 'Thread',
  dm: 'Direct message',
  group_dm: 'Group message'
}

/** The type of a channel in words: "Text channel" (the subtitle of the delete dialog, M51). */
export const channelKindName = (type: ChannelType): string => KIND_NAMES[type]

/** A channel that belongs to a guild (text, voice or category; never a DM). */
export type GuildChannel = Channel & { guildId: string }

export function isGuildChannel(channel: Channel): channel is GuildChannel {
  return channel.guildId !== null
}

/** Sidebar order: text before voice, then position, then id. */
export function compareChannels(a: Channel, b: Channel): number {
  return (
    TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.position - b.position || a.id.localeCompare(b.id)
  )
}

export interface ChannelGroups {
  /** Channels with no (existing) parent, in input order. */
  loose: Channel[]
  /** Category channels, in input order. */
  categories: Channel[]
  /** Category id → its child channels, in input order. */
  byParent: Map<string, Channel[]>
}

/** Split a guild's sorted channels into loose channels, categories, and each category's children. O(n). */
export function groupChannels(channels: readonly Channel[]): ChannelGroups {
  const ids = new Set(channels.map((c) => c.id))
  const loose: Channel[] = []
  const categories: Channel[] = []
  const byParent = new Map<string, Channel[]>()
  for (const c of channels) {
    // Threads are reached from the header and the tabs, not the channel list (N12).
    if (c.type === 'thread') continue
    if (c.type === 'category') categories.push(c)
    else if (c.parentId && ids.has(c.parentId)) {
      const siblings = byParent.get(c.parentId)
      if (siblings) siblings.push(c)
      else byParent.set(c.parentId, [c])
    } else loose.push(c)
  }
  return { loose, categories, byParent }
}

export function displayName(
  member: Pick<Member, 'nick' | 'user'> | undefined,
  user?: User
): string {
  return member?.nick ?? member?.user.username ?? user?.username ?? 'Unknown'
}

/** Members by display name (a new array). */
export function sortMembersByName(members: Iterable<Member>): Member[] {
  return [...members].sort((a, b) => displayName(a).localeCompare(displayName(b)))
}

/** Roles highest position first, ties by id (a new array). */
export function rolesByPositionDesc(roles: Iterable<Role>): Role[] {
  return [...roles].sort((a, b) => b.position - a.position || a.id.localeCompare(b.id))
}

/** The member's roles, highest position first (excludes @everyone). */
export function memberRoles(
  member: Member | undefined,
  roles: Map<string, Role> | undefined
): Role[] {
  if (!member || !roles) return []
  return rolesByPositionDesc(
    member.roles.map((id) => roles.get(id)).filter((r): r is Role => r !== undefined)
  )
}

/** `0xRRGGBB` int → `#rrggbb`. (0 means "no color" in role data; callers decide the fallback.) */
export function hexColor(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`
}

/** CSS color of the member's highest colored role, or undefined. */
export function roleColor(
  member: Member | undefined,
  roles: Map<string, Role> | undefined
): string | undefined {
  const c = memberRoles(member, roles).find((r) => r.color !== 0)?.color
  return c === undefined ? undefined : hexColor(c)
}

export function dmName(channel: Channel): string {
  return channel.name ?? channel.recipients?.map((u) => u.username).join(', ') ?? 'Direct Message'
}

/** How a channel is titled: DMs as `@name`, guild channels as `#name`. */
export function channelLabel(channel: Channel): { name: string; sigil: '#' | '@' } {
  return channel.guildId === null
    ? { name: dmName(channel), sigil: '@' }
    : { name: channel.name ?? '', sigil: '#' }
}

/**
 * The guild to show after the user leaves or deletes `leftId`: the next one in the user's guild
 * `order`, else the one before it. Null when no other guild is left, or `leftId` is not in it.
 */
export function guildAfterLeave(order: readonly string[], leftId: string): string | null {
  const at = order.indexOf(leftId)
  if (at < 0) return null
  return order[at + 1] ?? order[at - 1] ?? null
}

const DAY_MINUTES = 24 * 60

const count = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`

/** A span of whole minutes as one rounded unit: "7 days", "1 hour", "30 minutes". */
function spanWords(minutes: number): string {
  if (minutes >= DAY_MINUTES) return count(Math.round(minutes / DAY_MINUTES), 'day')
  if (minutes >= 60) return count(Math.round(minutes / 60), 'hour')
  return count(minutes, 'minute')
}

/**
 * The limits of an invite link in words, with the expiry date spelled out (M46): "Expires in 7
 * days, on Tuesday 13 October. Anyone with the link can join, as many times as they like." Under a
 * day it gives the time ("at 21:30"); a date in another year gets the year. `expiresAt` (ms) null:
 * the link never expires. `maxUses` 0: no limit. The date and time follow `locale`.
 */
export function inviteLimitsText(
  { expiresAt, maxUses }: { expiresAt: number | null; maxUses: number },
  now: number,
  locale?: string
): string {
  const uses =
    maxUses === 0
      ? 'Anyone with the link can join, as many times as they like.'
      : maxUses === 1
        ? 'One person can join with it.'
        : `Up to ${maxUses} people can join with it.`
  if (expiresAt === null) {
    return `This link never expires. Revoke it in Guild settings when you do not need it. ${uses}`
  }
  // In whole minutes, so a link made a moment ago still reads "1 day", not "24 hours".
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000))
  const date = new Date(expiresAt)
  const when =
    minutes < DAY_MINUTES
      ? `at ${new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date)}`
      : `on ${new Intl.DateTimeFormat(locale, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' })
        }).format(date)}`
  return `Expires in ${spanWords(minutes)}, ${when}. ${uses}`
}

/** Up to two initials for a guild tile: first letters of the first two words, else the first two characters. */
export function guildInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** Absent presence means offline. */
function isOnline(status: PresenceStatus | undefined): boolean {
  return status !== undefined && status !== 'offline'
}

/** Split `items` into [online, offline] by presence, preserving input order. */
export function partitionByPresence<T>(
  items: Iterable<T>,
  idOf: (item: T) => string,
  presences: ReadonlyMap<string, PresenceStatus>
): [online: T[], offline: T[]] {
  const online: T[] = []
  const offline: T[] = []
  for (const item of items) (isOnline(presences.get(idOf(item))) ? online : offline).push(item)
  return [online, offline]
}
