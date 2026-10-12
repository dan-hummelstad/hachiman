import { describe, expect, it } from 'vitest'
import {
  deviceNoun,
  formatCountdown,
  pathDisabled,
  recommendedPath,
  screenTitle,
  secondsLeft,
  selectedPath,
  type AccountFacts
} from '@/components/security/onboarding-steps'

const FIRST: AccountFacts = { hasMaster: false, passwordReset: false }
const EXISTING: AccountFacts = { hasMaster: true, passwordReset: false }
const RESET: AccountFacts = { hasMaster: false, passwordReset: true }

describe('deviceNoun', () => {
  it('says phone in the iOS app and on a touch phone', () => {
    expect(deviceNoun({ ios: true, mobile: true, coarse: true })).toBe('phone')
    expect(deviceNoun({ ios: false, mobile: true, coarse: true })).toBe('phone')
  })

  it('says device on the desktop and in a narrow desktop window', () => {
    expect(deviceNoun({ ios: false, mobile: false, coarse: false })).toBe('device')
    expect(deviceNoun({ ios: false, mobile: true, coarse: false })).toBe('device')
    expect(deviceNoun({ ios: false, mobile: false, coarse: true })).toBe('device')
  })
})

describe('screenTitle', () => {
  it('puts the noun in the choose and link titles', () => {
    expect(screenTitle('choose', 'phone')).toBe('Set up this phone')
    expect(screenTitle('link', 'phone')).toBe('Link this phone')
    expect(screenTitle('choose', 'device')).toBe('Set up this device')
  })
})

describe('recommendedPath', () => {
  it('suggests Link while the facts load and when the account has a key', () => {
    expect(recommendedPath(null)).toBe('link')
    expect(recommendedPath(EXISTING)).toBe('link')
  })

  it('suggests Restore after a password reset and Start new for a first device', () => {
    expect(recommendedPath(RESET)).toBe('restore')
    expect(recommendedPath(FIRST)).toBe('setup')
  })
})

describe('pathDisabled', () => {
  it('allows every path while the facts load', () => {
    expect(pathDisabled('link', null)).toBe(false)
    expect(pathDisabled('restore', null)).toBe(false)
    expect(pathDisabled('setup', null)).toBe(false)
  })

  it('blocks Start new when the account has a key', () => {
    expect(pathDisabled('setup', EXISTING)).toBe(true)
    expect(pathDisabled('link', EXISTING)).toBe(false)
  })

  it('leaves only Restore after a password reset', () => {
    expect(pathDisabled('link', RESET)).toBe(true)
    expect(pathDisabled('setup', RESET)).toBe(true)
    expect(pathDisabled('restore', RESET)).toBe(false)
  })

  it('never disables the suggested path', () => {
    for (const facts of [null, FIRST, EXISTING, RESET])
      expect(pathDisabled(recommendedPath(facts), facts)).toBe(false)
  })
})

describe('selectedPath', () => {
  it('follows the facts until the user picks', () => {
    expect(selectedPath(null, null)).toBe('link')
    expect(selectedPath(null, FIRST)).toBe('setup')
  })

  it('keeps the pick when the facts arrive', () => {
    expect(selectedPath('restore', FIRST)).toBe('restore')
    expect(selectedPath('link', FIRST)).toBe('link')
  })

  it('drops a pick that the facts make impossible', () => {
    expect(selectedPath('setup', EXISTING)).toBe('link')
    expect(selectedPath('link', RESET)).toBe('restore')
  })
})

describe('link code countdown', () => {
  it('counts whole seconds up, never below zero', () => {
    expect(secondsLeft(10_000, 0)).toBe(10)
    expect(secondsLeft(10_000, 9_001)).toBe(1)
    expect(secondsLeft(10_000, 10_000)).toBe(0)
    expect(secondsLeft(10_000, 12_000)).toBe(0)
  })

  it('formats m:ss', () => {
    expect(formatCountdown(588)).toBe('9:48')
    expect(formatCountdown(600)).toBe('10:00')
    expect(formatCountdown(5)).toBe('0:05')
    expect(formatCountdown(0)).toBe('0:00')
  })
})
