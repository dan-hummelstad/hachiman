/**
 * Custom guild emojis in E2EE content (contract §4 Emojis). The server never learns which emoji a
 * message uses: the message text holds `<:name:id>` (Discord format) and a reaction holds `name:id`.
 * A receiver shows the image of `id` from any guild it knows, else the text `:name:`.
 */
import type { GuildEmoji } from '@hachiman/client'

/** `<:name:id>` in a message text. `<a:name:id>` (Discord's animated form) reads the same. */
export const customEmojiText = (e: Pick<GuildEmoji, 'name' | 'id'>): string =>
  `<:${e.name}:${e.id}>`

export const customReactionKey = (e: Pick<GuildEmoji, 'name' | 'id'>): string => `${e.name}:${e.id}`

// No Unicode emoji sequence is ASCII letters, a colon and an id, so this cannot misread one.
const REACTION_KEY = /^([a-z0-9_]{2,32}):([\w-]{1,36})$/

/** A reaction key `name:id`, or null for a Unicode emoji. */
export function parseReactionKey(key: string): { name: string; id: string } | null {
  const m = REACTION_KEY.exec(key)
  return m ? { name: m[1]!, id: m[2]! } : null
}

/** Every known custom emoji by id, over all guilds. */
export function emojisById(
  byGuild: ReadonlyMap<string, readonly GuildEmoji[]>
): Map<string, GuildEmoji> {
  const out = new Map<string, GuildEmoji>()
  for (const list of byGuild.values()) for (const e of list) out.set(e.id, e)
  return out
}

/** A file name as an emoji name: lowercase, [a-z0-9_] only, 2 to 32 characters. */
export function emojiNameFromFile(fileName: string): string {
  const base = fileName
    .replace(/\.[^.]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
  return base.length >= 2 ? base : `emoji_${base}`.slice(0, 32)
}

/** What the emoji picker hands back: a Unicode emoji (in the chosen skin tone) or a custom guild emoji. */
export type EmojiPick = { kind: 'unicode'; emoji: string } | { kind: 'custom'; emoji: GuildEmoji }

/** The reaction key of a pick: the emoji itself, or `name:id`. */
export const reactionKeyOf = (pick: EmojiPick): string =>
  pick.kind === 'unicode' ? pick.emoji : customReactionKey(pick.emoji)

/** What a pick puts into a message text, and for a custom emoji its wire form for the send. */
export function emojiInsert(pick: EmojiPick): { insert: string; wire?: string } {
  return pick.kind === 'unicode'
    ? { insert: pick.emoji }
    : { insert: `:${pick.emoji.name}:`, wire: customEmojiText(pick.emoji) }
}

/** A sort comparator of guild ids: `guildId` (the current guild) first, the others in order. */
export const currentGuildFirst = (guildId: string | null, a: string, b: string): number =>
  a === guildId ? -1 : b === guildId ? 1 : 0

/**
 * At most `limit` custom emojis whose names hold `query` (colons stripped): the current guild
 * first, and names that start with it before the others.
 */
export function searchCustomEmoji(
  byGuild: ReadonlyMap<string, readonly GuildEmoji[]>,
  guildId: string | null,
  query: string,
  limit: number
): GuildEmoji[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, '')
  if (!q) return []
  const all = [...byGuild.entries()]
    .sort(([a], [b]) => currentGuildFirst(guildId, a, b))
    .flatMap(([, list]) => list)
  const starts = all.filter((e) => e.name.startsWith(q))
  const contains = all.filter((e) => !e.name.startsWith(q) && e.name.includes(q))
  return [...starts, ...contains].slice(0, limit)
}

/** The plain name of a reaction key, for labels: the emoji itself or `:name:`. */
export function reactionLabel(value: string): string {
  const custom = parseReactionKey(value)
  return custom ? `:${custom.name}:` : value
}
