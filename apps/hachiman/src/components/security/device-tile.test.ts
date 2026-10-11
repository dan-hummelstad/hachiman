import { describe, expect, it } from 'vitest'
import { deviceTileTone } from './device-tile'

describe('deviceTileTone', () => {
  it('marks this device in accent, whatever it runs', () => {
    expect(deviceTileTone({ platform: 'ios', current: true })).toBe('accent')
    expect(deviceTileTone({ platform: 'browser', current: true })).toBe('accent')
  })

  it('marks another browser in gold', () => {
    expect(deviceTileTone({ platform: 'browser' })).toBe('event')
    expect(deviceTileTone({ platform: 'browser', current: false })).toBe('event')
  })

  it('keeps other apps and an unknown platform grey', () => {
    expect(deviceTileTone({ platform: 'electron' })).toBe('neutral')
    expect(deviceTileTone({ platform: 'ios' })).toBe('neutral')
    expect(deviceTileTone({ platform: null })).toBe('neutral')
  })
})
