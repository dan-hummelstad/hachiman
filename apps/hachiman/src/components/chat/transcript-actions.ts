import { stripPageLinks } from '@/lib/page-link-text'
import { messagesService } from '@/services/MessagesService'
import type { ChatMessage } from '@/stores/messagesStore'

/** Adds or takes back my reaction. A failed send already took the optimistic chip back. */
export function react(channelId: string, target: string, emoji: string, remove: boolean): void {
  void messagesService
    .react(channelId, target, emoji, remove)
    .catch((e: unknown) => console.warn('[chat] reaction failed', e))
}

/** Scrolls the transcript to a loaded row and flashes it. */
export function scrollToMessage(messageId: string): void {
  const row = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
  if (!row) return
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  row.animate([{ backgroundColor: 'var(--accent-tint)' }, { backgroundColor: 'transparent' }], {
    duration: 1400,
    easing: 'ease-out'
  })
}

/** One line for a quoted message: its text without page links, or what it carries. */
export function quoteText(m: Pick<ChatMessage, 'content' | 'attachments'>): string {
  const text = stripPageLinks(m.content).replace(/\s+/g, ' ')
  if (text) return text
  const n = m.attachments.length
  return n === 0 ? 'Page link' : n === 1 ? m.attachments[0].name : `${n} attachments`
}
