import { describe, expect, it } from 'vitest'
import { frameRefused, frameUrl, webTabUrl } from './web-view'

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

describe('frameRefused', () => {
  const page = (frameOptions: string, csp = '') => ({ frameOptions, csp })
  it('refuses X-Frame-Options DENY and SAMEORIGIN', () => {
    expect(frameRefused(page('DENY'), APP)).toBe(true)
    expect(frameRefused(page('sameorigin'), APP)).toBe(true)
    expect(frameRefused(page(''), APP)).toBe(false)
    expect(frameRefused(page('ALLOW-FROM https://x.example'), APP)).toBe(false)
  })
  it('lets frame-ancestors decide over X-Frame-Options', () => {
    expect(frameRefused(page('DENY', 'frame-ancestors *'), APP)).toBe(false)
    expect(frameRefused(page('', "default-src 'self'; frame-ancestors 'self'"), APP)).toBe(true)
    expect(frameRefused(page('', "frame-ancestors 'none'"), APP)).toBe(true)
    expect(frameRefused(page('', 'frame-ancestors https://*.example.com'), APP)).toBe(false)
    expect(frameRefused(page('', 'frame-ancestors https://other.example'), APP)).toBe(true)
    expect(frameRefused(page('', 'frame-ancestors https:'), APP)).toBe(false)
  })
  it('a custom-scheme app (packaged Electron, iOS) matches no network source', () => {
    expect(frameRefused(page('', 'frame-ancestors *'), 'hachiman://app')).toBe(true)
    expect(frameRefused(page('', 'frame-ancestors hachiman:'), 'hachiman://app')).toBe(false)
  })
  it('refuses when any of several policies refuses', () => {
    expect(frameRefused(page('', 'frame-ancestors *, frame-ancestors https://x.example'), APP)).toBe(true)
  })
})
