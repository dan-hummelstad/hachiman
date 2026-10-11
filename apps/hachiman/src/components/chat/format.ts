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
 * Groups `items` by transcript slot: the index of the message that the item goes before. `at`
 * gives that index, -1 (no such message) for after the last of `length` messages, or null to
 * leave the item out. Items keep their order within one slot.
 */
function slotsBy<T>(
  items: Iterable<T>,
  length: number,
  at: (item: T) => number | null
): Map<number, T[]> {
  const slots = new Map<number, T[]>()
  for (const item of items) {
    const found = at(item)
    if (found === null) continue
    const i = found === -1 ? length : found
    const list = slots.get(i)
    if (list) list.push(item)
    else slots.set(i, [item])
  }
  return slots
}

/**
 * Where each membership event goes in the transcript: before the first loaded message of its
 * group at or after its epoch.
 */
export function membershipSlots(
  messages: readonly Pick<ChatMessage, 'groupId' | 'epoch'>[],
  events: readonly MembershipEvent[]
): Map<number, MembershipEvent[]> {
  return slotsBy(events, messages.length, (e) =>
    messages.findIndex((m) => m.groupId === e.groupId && m.epoch >= e.epoch)
  )
}

/**
 * Where each member join goes in the welcome channel: before the first loaded message after the
 * join, oldest first. A join before the first loaded message shows only when no older history is
 * left to load (`complete`), so it does not stack above a partial page.
 */
export function joinSlots(
  messages: readonly Pick<ChatMessage, 'createdAt'>[],
  members: Iterable<Member>,
  complete: boolean
): Map<number, Member[]> {
  const joins = [...members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
  return slotsBy(joins, messages.length, (m) => {
    const joined = Date.parse(m.joinedAt)
    const i = messages.findIndex((msg) => Date.parse(msg.createdAt) > joined)
    const at = i === -1 ? messages.length : i
    return at === 0 && !complete ? null : at
  })
}
