import { describe, expect, it } from 'vitest'
import {
  checkRecoveryKey,
  checkRecoveryKeyShape,
  decodeRecoveryKeyBody,
  recoveryKeyBody,
  recoveryKeyHint
} from './recovery-key'

// §12.11.3 test vector: rk = 0x00 … 0x1f, checksum 630d.
const VECTOR = 'HRK1-000G4-0R40M-30E20-9185G-R38E1-W8124-GK2GA-HC5RR-34D1P-70X3R-FP638'

describe('recovery key input', () => {
  it('accepts the contract test vector and decodes its bytes', async () => {
    expect(await checkRecoveryKey(VECTOR)).toEqual({ ok: true, text: VECTOR })
    const bytes = decodeRecoveryKeyBody(recoveryKeyBody(VECTOR))!
    expect([...bytes.slice(0, 32)]).toEqual(Array.from({ length: 32 }, (_, i) => i))
    expect([...bytes.slice(32)]).toEqual([0x63, 0x0d])
  })

  it('tolerates case, spaces, missing dashes, a missing prefix and the O/I/L aliases', async () => {
    const sloppy = VECTOR.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')
    expect(await checkRecoveryKey(sloppy)).toEqual({ ok: true, text: VECTOR })
    expect(await checkRecoveryKey(VECTOR.slice(5))).toEqual({ ok: true, text: VECTOR })
    expect(await checkRecoveryKey(VECTOR.replace(/-/g, '').replace(/1/g, 'I'))).toEqual({
      ok: true,
      text: VECTOR
    })
  })

  it('rejects U with its own hint, and other characters', () => {
    const u = checkRecoveryKeyShape(VECTOR.replace('G4', 'U4'))
    expect(u).toMatchObject({ ok: false, reason: 'bad_char' })
    expect(!u.ok && u.detail.includes('letter U')).toBe(true)
    expect(checkRecoveryKeyShape(VECTOR.replace('G4', '*4'))).toMatchObject({ reason: 'bad_char' })
  })

  it('reports the length while the user types', () => {
    expect(checkRecoveryKeyShape('')).toMatchObject({ reason: 'empty' })
    expect(checkRecoveryKeyShape('HRK1-000G4')).toMatchObject({
      reason: 'incomplete',
      detail: '5 of 55 characters.'
    })
    expect(checkRecoveryKeyShape(VECTOR + '0')).toMatchObject({ reason: 'too_long' })
  })

  it('finds a typo through the checksum', async () => {
    expect(await checkRecoveryKey(VECTOR.replace('0R40M', '0R41M'))).toMatchObject({
      ok: false,
      reason: 'checksum'
    })
  })

  it('rejects non-zero pad bits', async () => {
    // The last character carries 2 data bits and 3 pad bits: 8 = 01000 sets a pad bit.
    expect(decodeRecoveryKeyBody(recoveryKeyBody(VECTOR.slice(0, -1) + '9'))).toBeNull()
    expect(await checkRecoveryKey(VECTOR.slice(0, -1) + '9')).toMatchObject({ reason: 'checksum' })
  })
})

const FULL = `HRK1-${'ABCDE-'.repeat(10)}FGHJK`
const TOUCH_HELP = 'In groups of 5. Case, spaces and dashes do not matter.'

describe('recoveryKeyHint', () => {
  it('shows the help for an empty field', () => {
    expect(recoveryKeyHint('')).toMatchObject({
      text: '55 characters, in groups of 5. Case, spaces and dashes do not matter.',
      count: 0,
      complete: false,
      invalid: false,
      ready: false
    })
    expect(recoveryKeyHint('', 'touch').text).toBe(TOUCH_HELP)
  })

  it('counts an incomplete key in the dialog text, and only beside the touch helper', () => {
    expect(recoveryKeyHint('HRK1-ABCDE-FG').text).toBe('7 of 55 characters.')
    expect(recoveryKeyHint('HRK1-ABCDE-FG', 'touch')).toMatchObject({
      text: TOUCH_HELP,
      count: 7,
      complete: false,
      invalid: false,
      ready: false
    })
  })

  it('marks a full key complete and ready, with or without separators and in any case', () => {
    for (const input of [FULL, FULL.toLowerCase(), FULL.replace(/-/g, ' ')]) {
      expect(recoveryKeyHint(input, 'touch')).toMatchObject({
        text: 'All 55 characters are there.',
        count: 55,
        complete: true,
        invalid: false,
        ready: true
      })
    }
  })

  it('names a character that keys do not use', () => {
    const hint = recoveryKeyHint('HRK1-ABCDU', 'touch')
    expect(hint.invalid).toBe(true)
    expect(hint.complete).toBe(false)
    expect(hint.text).toContain('letter U')
  })

  it('caps the count at 55 for a key that is too long, but lets the user try it', () => {
    const hint = recoveryKeyHint(`${FULL}-XX`, 'touch')
    expect(hint).toMatchObject({ count: 55, complete: false, invalid: true, ready: true })
    expect(hint.text).toBe('The key has 2 characters too many.')
  })

  it('lets a full key with a bad character go to the check, which names the character', () => {
    const hint = recoveryKeyHint(`${FULL.slice(0, -1)}U`)
    expect(hint.ready).toBe(true)
    expect(hint.invalid).toBe(true)
  })
})
