import { describe, expect, it } from 'vitest'
import { clip, parseLinkPage, previewUrlOf } from './link-preview'

describe('previewUrlOf', () => {
  it('takes the first https link, skipping http and the skipped origin', () => {
    expect(previewUrlOf('see http://a.example and https://b.example/x.', null)).toBe(
      'https://b.example/x'
    )
    expect(
      previewUrlOf(
        'join https://takusen.example/invite/abc then https://c.example',
        'https://takusen.example'
      )
    ).toBe('https://c.example')
    expect(previewUrlOf('no links here', null)).toBeNull()
    expect(previewUrlOf(`https://d.example/${'a'.repeat(2100)}`, null)).toBeNull()
  })
})

describe('parseLinkPage', () => {
  const page = (head: string): string =>
    `<!doctype html><html><head>${head}</head><body><meta property="og:title" content="body"></body></html>`

  it('prefers OpenGraph, decodes entities and resolves the image against the page', () => {
    const p = parseLinkPage(
      page(`<title>Plain</title>
        <meta content='Tom &amp; Jerry &#x2764;' property="og:title">
        <meta name="description" content="A &quot;cat&quot;   and
          a mouse">
        <meta property="og:site_name" content="Toons">
        <meta property="og:image" content="/img/a.png">`),
      'https://toons.example/show/1'
    )
    expect(p).toEqual({
      title: 'Tom & Jerry ❤',
      description: 'A "cat" and a mouse',
      siteName: 'Toons',
      imageUrl: 'https://toons.example/img/a.png'
    })
  })

  it('falls back to <title>, drops a non-https image, ignores tags in the body', () => {
    expect(
      parseLinkPage(
        page(
          '<title>Only &lt;title&gt;</title><meta property="og:image" content="http://x.example/a.png">'
        ),
        'https://x.example/'
      )
    ).toEqual({ title: 'Only <title>', description: '', siteName: '', imageUrl: null })
    expect(parseLinkPage(page(''), 'https://x.example/')).toBeNull()
  })
})

describe('clip', () => {
  it('cuts on a code point with an ellipsis, inside the byte limit', () => {
    expect(clip('short', 10)).toBe('short')
    const cut = clip('é'.repeat(20), 11)
    expect(cut).toBe('éééé…')
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(11)
    expect(clip(`a${' '.repeat(50)}b${'c'.repeat(50)}`, 10)).toBe('a bcccc…')
  })
})
