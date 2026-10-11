import { describe, expect, it } from 'vitest'
import { pageIdOfHref, pageHref, pageLinkMarkdown } from './page-links'

describe('page links', () => {
  it('round-trips a page href', () => {
    const id = '0190a6f2-7f3c-7a51-9e0b-2b9f6c3d4e5f'
    expect(pageIdOfHref(pageHref(id))).toBe(id)
    expect(pageIdOfHref('https://example.com')).toBeNull()
    expect(pageIdOfHref('hachiman:page/../x')).toBeNull()
  })

  it('escapes brackets and backslashes in the markdown link text', () => {
    const id = '0190a6f2-7f3c-7a51-9e0b-2b9f6c3d4e5f'
    expect(pageLinkMarkdown({ id, title: 'Q3 [draft] a\\b', titleState: 'ok' })).toBe(
      `[Q3 \\[draft\\] a\\\\b](hachiman:page/${id})`
    )
    expect(pageLinkMarkdown({ id, title: '  ', titleState: 'ok' })).toBe(
      `[Untitled](hachiman:page/${id})`
    )
  })
})
