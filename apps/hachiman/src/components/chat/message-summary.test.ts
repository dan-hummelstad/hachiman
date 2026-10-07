import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/stores/messagesStore'
import { messageSummary, quoteText } from './message-summary'

const PAGE = 'hachiman:page/0a1b2c3d-0000-4000-8000-000000000001'
const file = (name: string): ChatMessage['attachments'][number] =>
  ({ name }) as ChatMessage['attachments'][number]

describe('messageSummary', () => {
  it('drops the page links from the text', () => {
    const s = messageSummary({ content: `see [Plan](${PAGE}) now`, attachments: [] })
    expect(s.text).toBe('see  now')
    expect(s.pageLink).toBe(true)
    expect(s.files).toBeNull()
  })

  it('names one attachment and counts more as attachments', () => {
    expect(messageSummary({ content: '', attachments: [file('a.png')] }).files).toBe('a.png')
    expect(messageSummary({ content: '', attachments: [file('a.png'), file('b.png')] }).files).toBe(
      '2 attachments'
    )
  })
})

describe('quoteText', () => {
  it('gives one line of text, else the attachments, else "Page link"', () => {
    expect(quoteText({ content: 'a\n\nb', attachments: [] })).toBe('a b')
    expect(quoteText({ content: '', attachments: [file('a.png'), file('b.png')] })).toBe(
      '2 attachments'
    )
    expect(quoteText({ content: PAGE, attachments: [] })).toBe('Page link')
  })
})
