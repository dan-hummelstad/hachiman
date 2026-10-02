/** An `@username` or `<@userId>` reference. */
export type MentionToken = { kind: 'mention'; value: string } & (
  { userId: string } | { username: string }
)

export type Token = { kind: 'text'; value: string } | { kind: 'link'; value: string } | MentionToken

// link | <@id> | @username (ends on a word char, so "@kestrel." stops before the dot)
const TOKEN_RE = /(https?:\/\/[^\s<>]+[^\s<>.,;:!?'")\]])|<@([\w-]+)>|@([\w.-]*\w)/g

/** Split a message body into plain text, mentions and links. The one mention parser. */
export function tokenize(content: string): Token[] {
  const out: Token[] = []
  let last = 0
  for (const m of content.matchAll(TOKEN_RE)) {
    const [value, link, userId, username] = m
    const i = m.index
    // An "@" glued to a word (e.g. an email) isn't a mention.
    if (username && i > 0 && /\w/.test(content[i - 1])) continue
    if (i > last) out.push({ kind: 'text', value: content.slice(last, i) })
    if (link) out.push({ kind: 'link', value })
    else if (userId) out.push({ kind: 'mention', value, userId })
    else out.push({ kind: 'mention', value, username })
    last = i + value.length
  }
  if (last < content.length) out.push({ kind: 'text', value: content.slice(last) })
  return out
}

/** Whether `token` mentions `me` (by id, or by username case-insensitively). */
export function mentionsUser(token: Token, me: { id: string; username: string }): boolean {
  if (token.kind !== 'mention') return false
  return 'userId' in token
    ? token.userId === me.id
    : token.username.toLowerCase() === me.username.toLowerCase()
}

/** Whether `content` mentions `me`. */
export function mentionsMe(content: string, me: { id: string; username: string }): boolean {
  return tokenize(content).some((t) => mentionsUser(t, me))
}
