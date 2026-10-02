import { describe, expect, it } from 'vitest'
import { EMBEDDABLE, embedKind } from './files'

describe('embedKind', () => {
  it.each([
    ['image/png', 'image'],
    ['image/avif', 'image'],
    ['IMAGE/JPEG', 'image'],
    ['video/webm; codecs="vp9,opus"', 'video'],
    ['audio/ogg;codecs=opus', 'audio'],
    [' audio/mp4 ', 'audio'],
    ['image/svg+xml', 'file'],
    ['image/bmp', 'file'],
    ['text/html', 'file'],
    ['application/octet-stream', 'file'],
    ['', 'file'],
  ] as const)('%s → %s', (type, want) => {
    expect(embedKind(type)).toBe(want)
  })

  it('every listed type maps to its own kind', () => {
    for (const kind of ['image', 'video', 'audio'] as const)
      for (const type of EMBEDDABLE[kind]) expect(embedKind(type)).toBe(kind)
  })
})
