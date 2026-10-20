import type { AttachmentPointer, ThumbnailPointer } from '@hachiman/crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import type { LinkResource } from '@/shared/IPlatformService'
import { usePrefsStore } from '@/stores/prefsStore'

const routes = new Map<string, LinkResource>()
const fetchLinkResource = vi.fn(async (url: string) => routes.get(url) ?? null)
const uploads: { type: string; maxEdge: number }[] = []

vi.mock('@/services/hachiman', () => ({ hostPlatform: () => ({ fetchLinkResource }) }))
vi.mock('@/services/TakusenService', () => ({
  takusenService: { env: { issuerOrigin: 'https://takusen.example' } }
}))
vi.mock('./UploadService', () => ({
  uploadLinkImage: async (blob: Blob, maxEdge: number): Promise<ThumbnailPointer> => {
    uploads.push({ type: blob.type, maxEdge })
    return {
      uploadId: 'u1',
      key: 'k',
      sha256: 's',
      size: 1,
      blobSize: 2,
      mime: blob.type,
      width: 10,
      height: 5
    }
  }
}))

const { linkPreviewFor } = await import('./link-preview')

const res = (url: string, contentType: string, body = ''): LinkResource => ({
  url,
  contentType,
  body: new TextEncoder().encode(body)
})

beforeEach(() => {
  routes.clear()
  uploads.length = 0
  fetchLinkResource.mockClear()
  usePrefsStore.setState({ linkPreviews: true })
})

it('a link straight to an image gives the image alone, at the larger edge', async () => {
  routes.set('https://i.example/cat.png', res('https://i.example/cat.png', 'image/png', 'png'))
  const p = await linkPreviewFor('look https://i.example/cat.png', [])
  expect(p).toMatchObject({
    url: 'https://i.example/cat.png',
    title: '',
    description: '',
    siteName: ''
  })
  expect(p?.image?.uploadId).toBe('u1')
  expect(uploads).toEqual([{ type: 'image/png', maxEdge: 1280 }])
})

it('a GIF link embeds; with no upload id left there is no preview', async () => {
  routes.set('https://i.example/a.gif', res('https://i.example/a.gif', 'image/gif', 'gif'))
  expect((await linkPreviewFor('https://i.example/a.gif', []))?.image?.mime).toBe('image/gif')
  const full = Array.from({ length: 10 }, (_, i) => ({
    uploadId: `f${i}`,
    thumbnail: { uploadId: `t${i}` }
  })) as unknown as AttachmentPointer[]
  expect(await linkPreviewFor('https://i.example/a.gif', full)).toBeNull()
})

it('a page gives its OpenGraph fields and a thumbnail of its image', async () => {
  routes.set(
    'https://news.example/a',
    res(
      'https://news.example/a',
      'text/html',
      '<meta property="og:title" content="Story"><meta property="og:image" content="/i.jpg">'
    )
  )
  routes.set('https://news.example/i.jpg', res('https://news.example/i.jpg', 'image/jpeg', 'jpg'))
  const p = await linkPreviewFor('read https://news.example/a', [])
  expect(p).toMatchObject({ title: 'Story', image: { uploadId: 'u1' } })
  expect(uploads).toEqual([{ type: 'image/jpeg', maxEdge: 640 }])
})

it('a page whose meta tags come after a long head (YouTube) still gives a preview', async () => {
  const script = `<script>var ytInitialData = "${'x'.repeat(700_000)}";</script>`
  routes.set(
    'https://www.youtube.com/watch?v=abc',
    res(
      'https://www.youtube.com/watch?v=abc',
      'text/html',
      `<html><head>${script}<title>Video - YouTube</title>` +
        '<meta property="og:title" content="Video"><meta property="og:site_name" content="YouTube">' +
        '<meta property="og:image" content="https://i.ytimg.com/vi/abc/maxresdefault.jpg"></head><body></body></html>'
    )
  )
  routes.set(
    'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
    res('https://i.ytimg.com/vi/abc/maxresdefault.jpg', 'image/jpeg', 'jpg')
  )
  const p = await linkPreviewFor('https://www.youtube.com/watch?v=abc', [])
  expect(p).toMatchObject({ title: 'Video', siteName: 'YouTube', image: { uploadId: 'u1' } })
})

it('no preview for SVG, plain text, the Takusen origin or with the setting off', async () => {
  routes.set('https://i.example/x.svg', res('https://i.example/x.svg', 'image/svg+xml', '<svg/>'))
  routes.set('https://i.example/x.txt', res('https://i.example/x.txt', 'text/plain', 'hi'))
  expect(await linkPreviewFor('https://i.example/x.svg', [])).toBeNull()
  expect(await linkPreviewFor('https://i.example/x.txt', [])).toBeNull()
  expect(await linkPreviewFor('https://takusen.example/invite/abc', [])).toBeNull()
  usePrefsStore.setState({ linkPreviews: false })
  routes.set('https://i.example/cat.png', res('https://i.example/cat.png', 'image/png', 'png'))
  expect(await linkPreviewFor('https://i.example/cat.png', [])).toBeNull()
  expect(uploads).toEqual([])
})
