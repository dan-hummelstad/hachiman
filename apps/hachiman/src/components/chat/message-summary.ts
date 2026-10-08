import { plainEmojiText } from '@/lib/mentions'
import { pageLinksOf, stripPageLinks } from '@/lib/page-link-text'
import type { ChatMessage } from '@/stores/messagesStore'

type Summed = Pick<ChatMessage, 'content' | 'attachments'>

export interface MessageSummary {
  /** The text without its page links (they show as cards in the transcript). */
  text: string
  /** "photo.png" or "3 attachments", or null without attachments. */
  files: string | null
  /** The message links to at least one page. */
  pageLink: boolean
}

/** What a decrypted message carries, for the previews in pins, the inbox and reply quotes. */
export function messageSummary(m: Summed): MessageSummary {
  const n = m.attachments.length
  return {
    text: plainEmojiText(stripPageLinks(m.content)),
    files: n === 0 ? null : n === 1 ? m.attachments[0].name : `${n} attachments`,
    pageLink: pageLinksOf(m.content).length > 0
  }
}

/** One line for a quoted message: its text without page links, or what it carries. */
export function quoteText(m: Summed): string {
  const s = messageSummary(m)
  return s.text.replace(/\s+/g, ' ') || s.files || 'Page link'
}
