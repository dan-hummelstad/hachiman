import { describe, expect, it } from 'vitest'
import { tokenOrigin } from './start'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')

describe('tokenOrigin', () => {
  it('reads the server that the token names', () => {
    expect(tokenOrigin(`hbot_${b64('https://chat.example.com')}.h1.${'a'.repeat(43)}`)).toBe(
      'https://chat.example.com',
    )
  })
  it('gives null for a token of the first form, or an origin that is not http(s)', () => {
    expect(tokenOrigin(`hbot_${'a'.repeat(43)}`)).toBeNull()
    expect(tokenOrigin(`hbot_${b64('javascript:alert(1)')}.h1.${'a'.repeat(43)}`)).toBeNull()
    expect(tokenOrigin(`hbot_${b64('not a url')}.h1.${'a'.repeat(43)}`)).toBeNull()
  })
})
