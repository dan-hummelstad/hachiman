import { describe, expect, it } from 'vitest'
import { canShareScreen } from './media-caps'

const getDisplayMedia = (): Promise<MediaStream> => Promise.reject(new Error('not called'))

describe('canShareScreen', () => {
  it('is true when getDisplayMedia is a function', () => {
    expect(canShareScreen({ mediaDevices: { getDisplayMedia } })).toBe(true)
  })

  it('is false without getDisplayMedia (iOS WKWebView)', () => {
    expect(canShareScreen({ mediaDevices: {} })).toBe(false)
  })

  it('is false without mediaDevices (an insecure context)', () => {
    expect(canShareScreen({})).toBe(false)
    expect(canShareScreen(undefined)).toBe(false)
  })
})
