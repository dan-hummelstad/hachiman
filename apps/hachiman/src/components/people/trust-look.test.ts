import { describe, expect, it } from 'vitest'
import { TRUST_LOOK } from './trust-look'

describe('TRUST_LOOK', () => {
  it('offers Verify only for a contact with a key that is not verified', () => {
    expect(TRUST_LOOK.tofu.canVerify).toBe(true)
    expect(TRUST_LOOK.changed.canVerify).toBe(true)
    expect(TRUST_LOOK.verified.canVerify).toBe(false)
    expect(TRUST_LOOK.unknown.canVerify).toBe(false)
  })

  it('names a contact with a key "Not verified" and one without "No key yet"', () => {
    expect(TRUST_LOOK.tofu.label).toBe('Not verified')
    expect(TRUST_LOOK.unknown.label).toBe('No key yet')
    expect(TRUST_LOOK.changed.label).toBe('Key changed')
    expect(TRUST_LOOK.verified.label).toBe('Verified')
  })
})
