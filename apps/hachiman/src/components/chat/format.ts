import type { Member } from '@hachiman/client'
import type { MembershipEvent } from '@hachiman/crypto'
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

/**
 * Where each membership event goes in the transcript: before the first loaded message of its
 * group at or after its epoch. The key is that message's index; `messages.length` means after
 * the last message. Events keep their order within one slot.
 */
export function membershipSlots(
  messages: readonly Pick<ChatMessage, 'groupId' | 'epoch'>[],
  events: readonly MembershipEvent[]
): Map<number, MembershipEvent[]> {
  const slots = new Map<number, MembershipEvent[]>()
  for (const e of events) {
    const i = messages.findIndex((m) => m.groupId === e.groupId && m.epoch >= e.epoch)
    const at = i === -1 ? messages.length : i
    const list = slots.get(at)
    if (list) list.push(e)
    else slots.set(at, [e])
  }
  return slots
}

/**
 * Where each member join goes in the welcome channel: before the first loaded message after the
 * join, keyed like membershipSlots. A join before the first loaded message shows only when no
 * older history is left to load (`complete`), so it does not stack above a partial page.
 */
export function joinSlots(
  messages: readonly Pick<ChatMessage, 'createdAt'>[],
  members: Iterable<Member>,
  complete: boolean
): Map<number, Member[]> {
  const slots = new Map<number, Member[]>()
  const joins = [...members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
  for (const m of joins) {
    const joined = Date.parse(m.joinedAt)
    const i = messages.findIndex((msg) => Date.parse(msg.createdAt) > joined)
    const at = i === -1 ? messages.length : i
    if (at === 0 && !complete) continue
    const list = slots.get(at)
    if (list) list.push(m)
    else slots.set(at, [m])
  }
  return slots
}
