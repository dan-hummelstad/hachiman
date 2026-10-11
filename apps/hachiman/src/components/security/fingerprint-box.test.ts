import { describe, expect, it } from 'vitest'
import { fingerprintGroups } from './fingerprint-box'

describe('fingerprintGroups', () => {
  it('splits hex into upper-case groups of 4', () => {
    expect(fingerprintGroups('7c2e91af0b44d3e85a19c6f02e7b8d31')).toEqual([
      '7C2E',
      '91AF',
      '0B44',
      'D3E8',
      '5A19',
      'C6F0',
      '2E7B',
      '8D31'
    ])
  })

  it('drops spaces and colons, so every notation gives the same groups', () => {
    const plain = fingerprintGroups('7c2e91af0b44d3e8')
    expect(fingerprintGroups('7C2E 91AF 0B44 D3E8')).toEqual(plain)
    expect(fingerprintGroups('7c:2e:91:af:0b:44:d3:e8')).toEqual(plain)
    expect(fingerprintGroups(' 7c2e\n91af 0b44\td3e8 ')).toEqual(plain)
  })

  it('keeps a short last group', () => {
    expect(fingerprintGroups('abcdef')).toEqual(['ABCD', 'EF'])
  })

  it('gives no groups for empty text', () => {
    expect(fingerprintGroups('')).toEqual([])
    expect(fingerprintGroups(' : ')).toEqual([])
  })
})
