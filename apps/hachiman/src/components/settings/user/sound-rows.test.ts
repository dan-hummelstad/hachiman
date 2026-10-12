import { describe, expect, it } from 'vitest'
import { SOUND_ROWS, soundRowOn } from '@/components/settings/user/sound-rows'
import { SOUND_EVENTS } from '@/lib/sounds'

describe('SOUND_ROWS', () => {
  it('lists every sound event exactly once', () => {
    const listed = SOUND_ROWS.flatMap((r) => r.events)
    expect([...listed].sort()).toEqual([...SOUND_EVENTS].sort())
  })

  it('pairs each sound with its opposite', () => {
    const pairs = SOUND_ROWS.filter((r) => r.events.length > 1).map((r) => r.events)
    expect(pairs).toEqual(
      expect.arrayContaining([
        ['mute', 'unmute'],
        ['deafen', 'undeafen'],
        ['voiceJoin', 'voiceLeave'],
        ['userJoin', 'userLeave']
      ])
    )
  })
})

describe('soundRowOn', () => {
  const mute = SOUND_ROWS.find((r) => r.events[0] === 'mute')!

  it('is on with no event of the row disabled', () => {
    expect(soundRowOn(mute, [])).toBe(true)
    expect(soundRowOn(mute, ['deafen'])).toBe(true)
  })

  it('is off when any event of the row is disabled', () => {
    expect(soundRowOn(mute, ['unmute'])).toBe(false)
    expect(soundRowOn(mute, ['mute', 'unmute'])).toBe(false)
  })
})
