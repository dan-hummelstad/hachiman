/**
 * What a new message means for me, computed once per MESSAGE_CREATE and shared by the unread
 * counts (N7) and the message sound (N9). The restart mention pass uses the same predicates.
 */
import type { User } from '@hachiman/client'
import { messageMentionsMe } from '@/lib/mentions'
import { hachiman } from '@/services/client'
import type { ChatMessage } from '@/stores/messagesStore'
import { selectedChannelId } from '@/stores/navStore'
import { isBlocked } from '@/stores/userStore'

export interface MessageContext {
  /** The channel is open and the window has focus. */
  viewing: boolean
  /** A notification: it counts as unread and may ping (see `isNotification`). */
  isNotification: boolean
  /** A notification whose decrypted content mentions me (or a role of mine, or everyone). */
  mentionsMe: boolean
}

/**
 * A row from someone else that I did not block. A message that is no row (a reaction, §12.8.1)
 * is no notification. A page activity is one: it shows as a line in the channel. A row that did
 * not decrypt counts too: it may be anything.
 */
export function isNotification(
  row: Pick<ChatMessage, 'author'> | undefined,
  meId: string | undefined,
  blocked: (userId: string) => boolean = isBlocked
): boolean {
  return (
    row !== undefined && meId !== undefined && row.author.id !== meId && !blocked(row.author.id)
  )
}

function myRoles(me: User, guildId: string | null): string[] {
  if (!guildId) return []
  return hachiman.cache.members.get(guildId)?.get(me.id)?.roles ?? []
}

/** A decrypted notification row that mentions me. */
export function mentionsMe(row: ChatMessage): boolean {
  const me = hachiman.cache.user
  return (
    !!me &&
    row.decrypt.status === 'ok' &&
    isNotification(row, me.id) &&
    messageMentionsMe(row, me, myRoles(me, row.guildId))
  )
}

export const isViewing = (channelId: string): boolean =>
  selectedChannelId() === channelId && typeof document !== 'undefined' && document.hasFocus()

export function messageContext(channelId: string, row: ChatMessage | undefined): MessageContext {
  const notification = isNotification(row, hachiman.cache.user?.id)
  return {
    viewing: isViewing(channelId),
    isNotification: notification,
    mentionsMe: notification && row !== undefined && mentionsMe(row)
  }
}
