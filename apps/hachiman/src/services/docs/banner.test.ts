import { describe, expect, it } from 'vitest'
import { BANNER_MAX_BLOB_BYTES, BANNER_MAX_BYTES, parseBanner } from './banner'

const utf8 = new TextEncoder()

const thumb = {
  uploadId: 'up-t',
  key: 'k',
  sha256: 's',
  size: 900,
  blobSize: 1000,
  mime: 'image/webp',
  width: 320,
  height: 80
}

const pointer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  uploadId: 'up-1',
  key: 'k',
  sha256: 's',
  size: 1000,
  blobSize: 1100,
  mime: 'image/webp',
  name: 'banner.webp',
  width: 2048,
  height: 512,
  durationMs: null,
  blurhash: null,
  thumbnail: thumb,
  ...over
})

const parse = (v: unknown): ReturnType<typeof parseBanner> =>
  parseBanner(utf8.encode(JSON.stringify(v)))

describe('parseBanner', () => {
  it('keeps a pointer of a banner image, with its known fields only', () => {
    expect(parse({ ...pointer(), extra: 'x' })).toEqual(pointer())
    for (const mime of ['image/png', 'image/jpeg', 'image/gif'])
      expect(parse(pointer({ mime }))?.mime).toBe(mime)
    const largest = { thumbnail: null, size: BANNER_MAX_BYTES, blobSize: BANNER_MAX_BLOB_BYTES }
    expect(parse(pointer(largest))?.thumbnail).toBeNull()
  })

  it('fails closed on bad JSON and bad UTF-8', () => {
    expect(parseBanner(utf8.encode('{"uploadId":'))).toBeNull()
    expect(parseBanner(new Uint8Array([0x7b, 0xff, 0x7d]))).toBeNull()
    expect(parseBanner(new Uint8Array())).toBeNull()
    expect(parse([pointer()])).toBeNull()
    expect(parse(null)).toBeNull()
  })

  it('takes only png, jpeg, webp and gif: no SVG, no other file', () => {
    expect(parse(pointer({ mime: 'image/svg+xml' }))).toBeNull()
    expect(parse(pointer({ mime: 'application/pdf' }))).toBeNull()
    expect(parse(pointer({ mime: 'video/mp4' }))).toBeNull()
    expect(parse(pointer({ thumbnail: { ...thumb, mime: 'image/svg+xml' } }))).toBeNull()
  })

  it('rejects a file over BANNER_MAX_BYTES, so a pointer cannot force a large download', () => {
    expect(parse(pointer({ size: BANNER_MAX_BYTES + 1 }))).toBeNull()
    expect(parse(pointer({ thumbnail: { ...thumb, size: BANNER_MAX_BYTES + 1 } }))).toBeNull()
  })

  it('bounds the blob that a viewer downloads, not only the declared file size', () => {
    // The §12.9 blob of an 8 MiB file: 13 header + 8650752 padded + 132 tags of 16.
    expect(BANNER_MAX_BLOB_BYTES).toBe(13 + 8_650_752 + 132 * 16)
    expect(parse(pointer({ blobSize: BANNER_MAX_BLOB_BYTES + 1 }))).toBeNull()
    expect(parse(pointer({ blobSize: 100 * 1024 * 1024 }))).toBeNull()
    expect(parse(pointer({ blobSize: 999 }))).toBeNull()
    expect(
      parse(pointer({ thumbnail: { ...thumb, blobSize: BANNER_MAX_BLOB_BYTES + 1 } }))
    ).toBeNull()
  })

  it('needs the dimensions', () => {
    expect(parse(pointer({ width: null }))).toBeNull()
    expect(parse(pointer({ height: null }))).toBeNull()
    expect(parse(pointer({ width: undefined }))).toBeNull()
  })
})
