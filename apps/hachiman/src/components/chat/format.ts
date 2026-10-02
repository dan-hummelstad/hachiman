import type { ChatMessage } from '@/stores/messagesStore'

/** Messages from one author within this window merge into one cozy group. */
const GROUP_WINDOW_MS = 7 * 60 * 1000

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})
const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric'
})
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })

/** `10:42` — 24h, fixed width, the transcript's one time format. */
export const formatTime = (iso: string): string => timeFmt.format(new Date(iso))
export const formatDay = (iso: string): string => dayFmt.format(new Date(iso))
export const formatFull = (iso: string): string => fullFmt.format(new Date(iso))

const dayKey = (iso: string): string => new Date(iso).toDateString()

export interface TranscriptItem {
  message: ChatMessage
  /** First message of a calendar day: render a divider above it. */
  newDay: boolean
  /** Starts a cozy group (author/time header). */
  groupStart: boolean
}

export function buildItems(messages: ChatMessage[]): TranscriptItem[] {
  let prev: ChatMessage | undefined
  return messages.map((message) => {
    const newDay = !prev || dayKey(prev.createdAt) !== dayKey(message.createdAt)
    const groupStart =
      newDay ||
      !prev ||
      prev.author.id !== message.author.id ||
      Date.parse(message.createdAt) - Date.parse(prev.createdAt) > GROUP_WINDOW_MS
    prev = message
    return { message, newDay, groupStart }
  })
}

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
