import { describe, expect, it } from 'vitest'
import { TRUST_LOOK, lookFor, securityText, shownTrust, trustButtonLabel } from './trust-look'

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

describe('lookFor', () => {
  it('shows a notice key change gold "Not verified" and a blocking one red', () => {
    expect(shownTrust('changed', 'notice')).toBe('tofu')
    expect(lookFor('changed', 'notice')).toBe(TRUST_LOOK.tofu)
    expect(lookFor('changed', 'blocking')).toBe(TRUST_LOOK.changed)
  })

  it('keeps "Key changed" when the severity is not known', () => {
    expect(lookFor('changed')).toBe(TRUST_LOOK.changed)
    expect(lookFor('changed', null)).toBe(TRUST_LOOK.changed)
  })

  it('gives every other state its own look, whatever the severity', () => {
    for (const state of ['verified', 'tofu', 'unknown'] as const) {
      expect(lookFor(state, 'notice')).toBe(TRUST_LOOK[state])
      expect(lookFor(state, 'blocking')).toBe(TRUST_LOOK[state])
    }
  })
})

describe('securityText', () => {
  const base = { name: 'yuki.h', verifiedOn: null, error: null }

  it('names the day of the verification when it is known', () => {
    expect(securityText({ ...base, state: 'verified', verifiedOn: '2 Oct' })).toBe(
      'You compared safety numbers on 2 Oct. Hachiman will tell you if this key ever changes.'
    )
    expect(securityText({ ...base, state: 'verified' })).toBe(
      'You compared safety numbers. Hachiman will tell you if this key ever changes.'
    )
  })

  it('asks for a first comparison after a notice change and a new one after a blocking change', () => {
    expect(securityText({ ...base, state: 'changed', keyChange: 'notice' })).toMatch(
      /^yuki\.h has a new security key\. Compare safety numbers once/
    )
    expect(securityText({ ...base, state: 'changed', keyChange: 'blocking' })).toBe(
      'The security key of yuki.h changed. Compare safety numbers again.'
    )
    expect(securityText({ ...base, state: 'changed' })).toBe(
      'The security key of yuki.h changed. Compare safety numbers again.'
    )
  })

  it('reads the loading, the error and the keyless states', () => {
    expect(securityText({ ...base, state: null })).toBe('Reading the security key…')
    expect(securityText({ ...base, state: 'tofu', error: 'down' })).toBe(
      'The security key cannot be read now.'
    )
    expect(securityText({ ...base, state: 'unknown' })).toBe(
      'Hachiman has no security key for yuki.h yet.'
    )
  })
})

describe('trustButtonLabel', () => {
  it('puts the state, the day and the action in the label', () => {
    expect(trustButtonLabel({ name: 'yuki.h', state: 'verified', verifiedOn: '2 Oct' })).toBe(
      'Verified on 2 Oct. Safety numbers of yuki.h'
    )
    expect(trustButtonLabel({ name: 'marlowe', state: 'tofu', verifiedOn: null })).toBe(
      'Not verified. Verify marlowe'
    )
    expect(
      trustButtonLabel({ name: 'marlowe', state: 'changed', keyChange: 'notice', verifiedOn: null })
    ).toBe('Not verified. Verify marlowe')
    expect(
      trustButtonLabel({
        name: 'marlowe',
        state: 'changed',
        keyChange: 'blocking',
        verifiedOn: null
      })
    ).toBe('Key changed. Verify marlowe again')
    expect(trustButtonLabel({ name: 'quill', state: 'unknown', verifiedOn: null })).toBe(
      'quill has no security key yet'
    )
  })
})
