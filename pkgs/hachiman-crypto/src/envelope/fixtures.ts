/** Test fixtures for the envelope, attachment and franking specs. Not exported from the package. */
import type { AttachmentPointer, MessageContent, ThumbnailPointer } from '../api'
import { toB64url } from '../codec'

export function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

export function bytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill)
}

export function thumbnail(id: number, overrides: Partial<ThumbnailPointer> = {}): ThumbnailPointer {
  return {
    uploadId: uuid(id),
    key: toB64url(bytes(32, 0x11)),
    sha256: toB64url(bytes(32, 0x22)),
    size: 1234,
    blobSize: 1300,
    mime: 'image/webp',
    width: 320,
    height: 180,
    ...overrides,
  }
}

export function pointer(id: number, overrides: Partial<AttachmentPointer> = {}): AttachmentPointer {
  return {
    uploadId: uuid(id),
    key: toB64url(bytes(32, 0x33)),
    sha256: toB64url(bytes(32, 0x44)),
    size: 100_000,
    blobSize: 106_525,
    mime: 'image/png',
    name: 'cat.png',
    width: 1920,
    height: 1080,
    durationMs: null,
    blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    thumbnail: null,
    ...overrides,
  }
}

export function content(overrides: Partial<MessageContent> = {}): MessageContent {
  return { text: 'hello', mentions: [], attachments: [], replyTo: null, linkPreview: null, sentAtMs: 1_700_000_000_000, ...overrides }
}

/**
 * The largest valid content of §12.8.4: 8000 text bytes, 100 mentions, 10 full pointers with
 * thumbnails, a full link preview (no image: the pointers use all 20 upload ids).
 */
export function largestContent(): MessageContent {
  const mime = `application/${'x'.repeat(127 - 'application/'.length)}`
  return {
    text: 'é'.repeat(4000),
    mentions: Array.from({ length: 100 }, (_, i) => ({ type: 'user' as const, id: uuid(1000 + i) })),
    attachments: Array.from({ length: 10 }, (_, i) =>
      pointer(2 * i + 1, {
        mime,
        name: 'n'.repeat(255),
        width: 0xffffffff,
        height: 0xffffffff,
        durationMs: 0xffffffff,
        blurhash: 'b'.repeat(100),
        size: Number.MAX_SAFE_INTEGER,
        blobSize: Number.MAX_SAFE_INTEGER,
        thumbnail: thumbnail(2 * i + 2, { mime, size: Number.MAX_SAFE_INTEGER, blobSize: Number.MAX_SAFE_INTEGER }),
      }),
    ),
    replyTo: toB64url(bytes(16, 0x55)),
    linkPreview: {
      url: `https://e.example/${'p'.repeat(2048 - 'https://e.example/'.length)}`,
      title: 't'.repeat(300),
      description: 'd'.repeat(1000),
      siteName: 's'.repeat(100),
      image: null,
    },
    sentAtMs: Number.MAX_SAFE_INTEGER,
  }
}

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}
