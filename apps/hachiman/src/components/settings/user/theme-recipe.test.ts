import { describe, expect, it } from 'vitest'
import { deriveTheme } from '@/lib/theme-engine'
import { findTheme } from '@/lib/theme-presets'
import { forkTheme, parseShared, shareText, switchGround } from './theme-recipe'

const midnight = findTheme('midnight', [])!

describe('theme recipes', () => {
  it('a fork drops the pins and gets a new id', () => {
    const fork = forkTheme(midnight)
    expect(fork.pins).toBeUndefined()
    expect(fork.id).not.toBe(midnight.id)
    expect(fork.id.startsWith('custom-')).toBe(true)
    expect(fork.name).toBe('Midnight copy')
  })

  it('switching ground keeps the pinned keys with values for the new ground', () => {
    const light = switchGround(midnight, 'light')
    expect(light.ground).toBe('light')
    expect(Object.keys(light.pins ?? {}).sort()).toEqual(Object.keys(midnight.pins ?? {}).sort())
    expect(light.pins?.window).not.toBe(midnight.pins?.window)
    expect(light.pins?.window).toBe(deriveTheme({ ...light, pins: undefined }).window)
  })

  it('shared text round-trips and junk is rejected', () => {
    const fork = forkTheme(midnight)
    const back = parseShared(shareText(fork))
    expect(back).not.toBeNull()
    expect(back?.id).not.toBe(fork.id)
    expect(back?.accent).toBe(fork.accent)
    expect(parseShared('nope')).toBeNull()
    expect(parseShared('{"name":"x"}')).toBeNull()
    expect(parseShared('null')).toBeNull()
  })

  it('clamps tint and separation of a shared theme', () => {
    const back = parseShared(JSON.stringify({ ...forkTheme(midnight), tint: 9, separation: 99 }))
    expect(back?.tint).toBe(0.3)
    expect(back?.separation).toBe(2.5)
  })
})
