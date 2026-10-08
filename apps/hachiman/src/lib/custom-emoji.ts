/**
 * Custom guild emojis in E2EE content (contract §4 Emojis). The server never learns which emoji a
 * message uses: the message text holds `<:name:id>` (Discord format) and a reaction holds `name:id`.
 * A receiver shows the image of `id` from any guild it knows, else the text `:name:`.
 */
import type { GuildEmoji } from '@hachiman/client'

/** `<:name:id>` in a message text. `<a:name:id>` (Discord's animated form) reads the same. */
export const customEmojiText = (e: Pick<GuildEmoji, 'name' | 'id'>): string =>
  `<:${e.name}:${e.id}>`

/** The reaction key of a custom emoji. */
export const customReactionKey = (e: Pick<GuildEmoji, 'name' | 'id'>): string => `${e.name}:${e.id}`

const REACTION_KEY = /^([a-z0-9_]{2,32}):([0-9a-f-]{36})$/

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

/** The plain name of a reaction key, for labels: the emoji itself or `:name:`. */
export function reactionLabel(value: string): string {
  const custom = parseReactionKey(value)
  return custom ? `:${custom.name}:` : value
}
