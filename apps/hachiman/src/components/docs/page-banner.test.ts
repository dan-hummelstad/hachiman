import { describe, expect, it } from 'vitest'
import type { AttachmentPointer } from '@hachiman/crypto'
import type { PageBannerState } from '@/hooks/use-page-banner'
import { bannerView } from './page-banner'

const POINTER: AttachmentPointer = {
  uploadId: 'up-1',
  key: '',
  sha256: '',
  size: 1000,
  blobSize: 1000,
  mime: 'image/webp',
  name: 'banner.webp',
  width: 1600,
  height: 400,
  durationMs: null,
  blurhash: null,
  thumbnail: null
}

const state = (over: Partial<PageBannerState> = {}): PageBannerState => ({
  rootId: 'root',
  isRoot: true,
  banner: null,
  known: true,
  ...over
})

describe('bannerView', () => {
  it('gives the editor of a top-level page Change and Remove on its banner', () => {
    expect(bannerView(state({ banner: POINTER }), true, false)).toEqual({
      show: 'image',
      controls: true,
      tile: true
    })
  })

  it('shows the banner of the top-level page on a sub-page, with no controls', () => {
    const sub = state({ isRoot: false, banner: POINTER })
    expect(bannerView(sub, true, false)).toEqual({ show: 'image', controls: false, tile: true })
  })

  it('shows the banner to a user who may not edit, with no controls', () => {
    expect(bannerView(state({ banner: POINTER }), false, false).controls).toBe(false)
  })

  it('offers "Add banner" only to an editor on a top-level page with no banner', () => {
    expect(bannerView(state(), true, false)).toEqual({ show: 'add', controls: false, tile: false })
    expect(bannerView(state(), false, false).show).toBe('nothing')
    expect(bannerView(state({ isRoot: false }), true, false).show).toBe('nothing')
  })

  it('shows nothing while the banner is not known, so "Add banner" does not flicker', () => {
    expect(bannerView(state({ known: false }), true, false).show).toBe('nothing')
    expect(bannerView(state({ known: false, banner: POINTER }), true, false).show).toBe('nothing')
  })

  it('shows nothing and no controls for an orphan', () => {
    const orphan = state({ rootId: null, isRoot: false })
    expect(bannerView(orphan, true, false)).toEqual({
      show: 'nothing',
      controls: false,
      tile: false
    })
    expect(bannerView(orphan, true, true).show).toBe('nothing')
  })

  it('has no tile without a banner', () => {
    expect(bannerView(state(), true, false).tile).toBe(false)
    expect(bannerView(state(), false, false).tile).toBe(false)
  })

  it('shows the upload preview of the top-level page, also before a banner is known', () => {
    expect(bannerView(state(), true, true)).toEqual({ show: 'image', controls: true, tile: true })
    expect(bannerView(state({ known: false }), true, true).show).toBe('image')
  })
})
