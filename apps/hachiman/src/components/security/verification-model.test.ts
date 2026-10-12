import { describe, expect, it } from 'vitest'
import { contactDevicePlatform, safetyRows, verificationFoot } from './verification-model'

const GROUPS = [
  '37291',
  '08465',
  '91203',
  '55817',
  '64038',
  '72914',
  '30572',
  '18846',
  '90127',
  '45583',
  '26709',
  '61432'
]

describe('safetyRows', () => {
  it('makes 3 rows of 4 groups from 12', () => {
    const rows = safetyRows(GROUPS)
    expect(rows.map((r) => r.groups)).toEqual([
      ['37291', '08465', '91203', '55817'],
      ['64038', '72914', '30572', '18846'],
      ['90127', '45583', '26709', '61432']
    ])
  })

  it('spells the digits of each group in the label, leading zeros kept', () => {
    expect(safetyRows(GROUPS)[0].label).toBe(
      'Row 1 of 3: 3 7 2 9 1, 0 8 4 6 5, 9 1 2 0 3, 5 5 8 1 7'
    )
    expect(safetyRows(GROUPS)[2].label).toMatch(/^Row 3 of 3: 9 0 1 2 7,/)
  })

  it('keeps a short last row', () => {
    const rows = safetyRows(GROUPS.slice(0, 6), 4)
    expect(rows.map((r) => r.groups.length)).toEqual([4, 2])
    expect(rows[1].label).toBe('Row 2 of 2: 6 4 0 3 8, 7 2 9 1 4')
  })

  it('gives no rows for no groups', () => {
    expect(safetyRows([])).toEqual([])
  })
})

describe('verificationFoot', () => {
  it('puts the primary action last', () => {
    expect(verificationFoot('tofu', false)).toEqual(['scan', 'markVerified'])
    expect(verificationFoot('changed', false)).toEqual(['acceptKey', 'scan', 'markVerified'])
    expect(verificationFoot(null, false)).toEqual(['scan', 'markVerified'])
    expect(verificationFoot('unknown', false)).toEqual(['scan', 'markVerified'])
  })

  it('offers removal, not marking, when verified, never at the bottom', () => {
    expect(verificationFoot('verified', false)).toEqual(['removeVerification', 'scan'])
  })

  it('shows only Cancel while the scan panel shows', () => {
    expect(verificationFoot('tofu', true)).toEqual(['cancelScan'])
    expect(verificationFoot('verified', true)).toEqual(['cancelScan'])
  })
})

describe('contactDevicePlatform', () => {
  it('maps the names that this app gives', () => {
    expect(contactDevicePlatform('Hachiman Desktop')).toBe('electron')
    expect(contactDevicePlatform('Hachiman Web')).toBe('browser')
    expect(contactDevicePlatform('Hachiman iOS')).toBe('ios')
  })

  it('gives null for any other name', () => {
    expect(contactDevicePlatform('Phone')).toBeNull()
    expect(contactDevicePlatform('hachiman desktop')).toBeNull()
    expect(contactDevicePlatform('constructor')).toBeNull()
  })
})
