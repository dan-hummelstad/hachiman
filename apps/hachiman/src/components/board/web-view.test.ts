import { describe, expect, it } from 'vitest'
import { frameUrl, webTabUrl } from './web-view'

const APP = 'https://chat.example.com'

describe('webTabUrl', () => {
  it('takes https and bare hosts', () => {
    expect(webTabUrl('https://example.org/a?b=1', APP)).toBe('https://example.org/a?b=1')
    expect(webTabUrl('  example.org ', APP)).toBe('https://example.org/')
  })
  it('refuses other schemes, the app origin and credentials', () => {
    for (const bad of [
      '',
      'http://example.org',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      `${APP}/x`,
      'https://user:pw@example.org'
    ])
      expect(webTabUrl(bad, APP), bad).toBeNull()
  })
})

describe('frameUrl', () => {
  it('loads a known video link in its embed form', () => {
    const yt = 'https://www.youtube.com/embed/dQw4w9WgXcQ'
    expect(frameUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1')).toBe(yt)
    expect(frameUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(yt)
    expect(frameUrl('https://m.youtube.com/shorts/dQw4w9WgXcQ')).toBe(yt)
    expect(frameUrl('https://vimeo.com/76979871')).toBe('https://player.vimeo.com/video/76979871')
  })
  it('loads any other address as it is', () => {
    for (const url of [
      'https://example.org/a',
      'https://www.youtube.com/watch?v=<x>',
      'https://vimeo.com/channels'
    ])
      expect(frameUrl(url)).toBe(url)
  })
})
