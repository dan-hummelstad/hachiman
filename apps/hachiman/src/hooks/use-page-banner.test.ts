import { describe, expect, it } from 'vitest'
import type { AttachmentPointer } from '@hachiman/crypto'
import type { PageNode } from '@/stores/docsStore'
import { pageBannerState } from './use-page-banner'

const BANNER = { uploadId: 'up-1', mime: 'image/webp' } as AttachmentPointer

const page = (id: string, parentId: string | null, over: Partial<PageNode> = {}): PageNode => ({
  id,
  channelId: 'c',
  parentId,
  position: 0,
  title: id,
  titleState: 'ok',
  banner: null,
  bannerPending: false,
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over
})

describe('pageBannerState', () => {
  const pages = [
    page('root', null, { banner: BANNER }),
    page('sub', 'root'),
    page('subsub', 'sub'),
    page('plain', null)
  ]

  it('a sub-page shows the banner of its top-level page, with no controls', () => {
    expect(pageBannerState(pages, 'root')).toEqual({
      rootId: 'root',
      isRoot: true,
      banner: BANNER,
      known: true
    })
    const sub = pageBannerState(pages, 'subsub')
    expect(sub).toEqual({ rootId: 'root', isRoot: false, banner: BANNER, known: true })
    // The stored reference, so a shallow compare keeps it.
    expect(sub.banner).toBe(pages[0]?.banner)
    expect(pageBannerState(pages, 'plain')).toMatchObject({ isRoot: true, banner: null })
  })

  it('is not known before the pages load or while the root banner waits for keys', () => {
    expect(pageBannerState(undefined, 'root').known).toBe(false)
    const waiting = [page('root', null, { bannerPending: true, titleState: 'pending' })]
    expect(pageBannerState(waiting, 'root')).toMatchObject({ known: false, banner: null })
    // A pending title alone does not hide the banner.
    const titleWaits = [page('root', null, { banner: BANNER, titleState: 'pending' })]
    expect(pageBannerState(titleWaits, 'root')).toMatchObject({ known: true, banner: BANNER })
  })

  it('an orphan or a missing page has no banner and no controls', () => {
    const orphan = [...pages, page('o', 'gone', { banner: BANNER })]
    expect(pageBannerState(orphan, 'o')).toEqual({
      rootId: null,
      isRoot: false,
      banner: null,
      known: true
    })
    expect(pageBannerState(pages, 'missing')).toMatchObject({ rootId: null, isRoot: false })
  })
})
