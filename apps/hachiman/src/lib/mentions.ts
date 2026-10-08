import type { Mention } from '@hachiman/crypto'

/** An `@username`, `<@userId>` or `<@&roleId>` reference. */
export type MentionToken = { kind: 'mention'; value: string } & (
  { userId: string } | { username: string } | { roleId: string }
)

/** A custom guild emoji `<:name:id>` (contract §4 Emojis). */
export type EmojiToken = { kind: 'emoji'; value: string; name: string; id: string }

export type Token =
  { kind: 'text'; value: string } | { kind: 'link'; value: string } | MentionToken | EmojiToken

// link | <@&roleId> | <@id> | @username (ends on a word char, so "@kestrel." stops before the dot)
// | <:name:id> (a custom emoji; Discord's animated <a:name:id> too)
const TOKEN_RE =
  /(https?:\/\/[^\s<>]+[^\s<>.,;:!?'")\]])|<@&([\w-]+)>|<@([\w-]+)>|@([\w.-]*\w)|<a?:(\w{2,32}):([\w-]+)>/g

/** `<:name:id>` anywhere in a text → `:name:`, for one-line previews. */
export const plainEmojiText = (text: string): string =>
  text.replace(/<a?:(\w{2,32}):[\w-]+>/g, ':$1:')

/** Split a message body into plain text, mentions and links. The one mention parser. */
export function tokenize(content: string): Token[] {
  const out: Token[] = []
  let last = 0
  for (const m of content.matchAll(TOKEN_RE)) {
    const [value, link, roleId, userId, username, emojiName, emojiId] = m
    const i = m.index
    // An "@" glued to a word (e.g. an email) isn't a mention.
    if (username && i > 0 && /\w/.test(content[i - 1])) continue
    if (i > last) out.push({ kind: 'text', value: content.slice(last, i) })
    if (link) out.push({ kind: 'link', value })
    else if (emojiName && emojiId) out.push({ kind: 'emoji', value, name: emojiName, id: emojiId })
    else if (roleId) out.push({ kind: 'mention', value, roleId })
    else if (userId) out.push({ kind: 'mention', value, userId })
    else out.push({ kind: 'mention', value, username })
    last = i + value.length
  }
  if (last < content.length) out.push({ kind: 'text', value: content.slice(last) })
  return out
}

/** Whether `token` mentions `me` (by id, or by username case-insensitively). */
export function mentionsUser(token: Token, me: { id: string; username: string }): boolean {
  if (token.kind !== 'mention' || 'roleId' in token) return false
  return 'userId' in token
    ? token.userId === me.id
    : token.username.toLowerCase() === me.username.toLowerCase()
}

/** Whether `content` mentions `me`. */
export function mentionsMe(content: string, me: { id: string; username: string }): boolean {
  return tokenize(content).some((t) => mentionsUser(t, me))
}

/** At most this many mentions go into one envelope (§12.8.1). */
export const MAX_MENTIONS = 100

/**
 * The structured mentions of a message text, for the envelope. `<@id>` mentions that user,
 * `<@&id>` that role, `@everyone` everyone, and `@username` the user that `resolve` finds (else
 * nothing).
 */
export function mentionsOf(
  content: string,
  resolve: (username: string) => string | null
): Mention[] {
  const out: Mention[] = []
  const seen = new Set<string>()
  const add = (m: Mention): void => {
    const key = `${m.type}:${m.id ?? ''}`
    if (seen.has(key) || out.length >= MAX_MENTIONS) return
    seen.add(key)
    out.push(m)
  }
  for (const t of tokenize(content)) {
    if (t.kind !== 'mention') continue
    if ('roleId' in t) add({ type: 'role', id: t.roleId })
    else if ('userId' in t) add({ type: 'user', id: t.userId })
    else if (t.username.toLowerCase() === 'everyone') add({ type: 'everyone', id: null })
    else {
      const id = resolve(t.username)
      if (id) add({ type: 'user', id })
    }
  }
  return out
}

/**
 * Whether a decrypted message mentions `me`: by the structured mentions of the envelope (me,
 * everyone, or one of `myRoleIds`), or by the text.
 */
export function messageMentionsMe(
  message: { content: string; mentions: readonly Mention[] },
  me: { id: string; username: string },
  myRoleIds: readonly string[] = []
): boolean {
  const byList = message.mentions.some(
    (m) =>
      m.type === 'everyone' ||
      (m.type === 'user' && m.id === me.id) ||
      (m.type === 'role' && m.id !== null && myRoleIds.includes(m.id))
  )
  return byList || mentionsMe(message.content, me)
}
