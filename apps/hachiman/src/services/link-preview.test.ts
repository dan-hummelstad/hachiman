import { beforeEach, expect, it, vi } from 'vitest'
import type { LinkResource } from '@/shared/IPlatformService'

const routes = new Map<string, LinkResource>()
const fetchLinkResource = vi.fn(async (url: string) => routes.get(url) ?? null)

vi.mock('@/services/hachiman', () => ({ hostPlatform: () => ({ fetchLinkResource }) }))
URL.createObjectURL = (blob: Blob) => `blob:${blob.type}`
URL.revokeObjectURL = () => {}

const { loadLinkPreview } = await import('./link-preview')

const res = (url: string, contentType: string, body = ''): LinkResource => ({
  url,
  contentType,
  frameOptions: '',
  csp: '',
  body: new TextEncoder().encode(body)
})

beforeEach(() => {
  routes.clear()
  fetchLinkResource.mockClear()
})

it('a link straight to an image gives the image alone', async () => {
  routes.set('https://i.example/cat.png', res('https://i.example/cat.png', 'image/png', 'png'))
  expect(await loadLinkPreview('https://i.example/cat.png')).toEqual({
    url: 'https://i.example/cat.png',
    title: '',
    description: '',
    siteName: '',
    image: 'blob:image/png'
  })
})

it('a page gives its OpenGraph fields and its image; one fetch per URL', async () => {
  routes.set(
    'https://news.example/a',
    res(
      'https://news.example/a',
      'text/html',
      '<meta property="og:title" content="Story"><meta property="og:image" content="/i.jpg">'
    )
  )
  routes.set('https://news.example/i.jpg', res('https://news.example/i.jpg', 'image/jpeg', 'jpg'))
  const p = await loadLinkPreview('https://news.example/a')
  expect(p).toMatchObject({ title: 'Story', image: 'blob:image/jpeg' })
  await loadLinkPreview('https://news.example/a')
  expect(fetchLinkResource).toHaveBeenCalledTimes(2)
})

it('a page whose meta tags come after a long head (YouTube) still gives a preview', async () => {
  const script = `<script>var ytInitialData = "${'x'.repeat(700_000)}";</script>`
  routes.set(
    'https://www.youtube.com/watch?v=abc',
    res(
      'https://www.youtube.com/watch?v=abc',
      'text/html',
      `<html><head>${script}<title>Video - YouTube</title>` +
        '<meta property="og:title" content="Video"><meta property="og:site_name" content="YouTube"></head></html>'
    )
  )
  expect(await loadLinkPreview('https://www.youtube.com/watch?v=abc')).toMatchObject({
    title: 'Video',
    siteName: 'YouTube',
    image: null
  })
})

it('no preview for SVG or plain text, and no SVG page image', async () => {
  routes.set('https://i.example/x.svg', res('https://i.example/x.svg', 'image/svg+xml', '<svg/>'))
  routes.set('https://i.example/x.txt', res('https://i.example/x.txt', 'text/plain', 'hi'))
  expect(await loadLinkPreview('https://i.example/x.svg')).toBeNull()
  expect(await loadLinkPreview('https://i.example/x.txt')).toBeNull()
  routes.set(
    'https://p.example/',
    res(
      'https://p.example/',
      'text/html',
      '<title>P</title><meta property="og:image" content="/x.svg">'
    )
  )
  routes.set('https://p.example/x.svg', res('https://p.example/x.svg', 'image/svg+xml', '<svg/>'))
  expect(await loadLinkPreview('https://p.example/')).toMatchObject({ title: 'P', image: null })
})
