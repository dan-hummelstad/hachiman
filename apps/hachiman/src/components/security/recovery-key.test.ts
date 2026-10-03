import { describe, expect, it } from 'vitest'
import {
  checkRecoveryKey,
  checkRecoveryKeyShape,
  decodeRecoveryKeyBody,
  recoveryKeyBody
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
