import { describe, expect, it } from 'vitest'
import { checkCode } from './scan-code'

const PREFIX = 'hachiman-verify:1:'

describe('checkCode', () => {
  it('reads null as a cancel', () => {
    expect(checkCode(PREFIX, null)).toEqual({ kind: 'cancel' })
  })

  it('accepts a code with the prefix and trims it', () => {
    expect(checkCode(PREFIX, `  ${PREFIX}abc\n`)).toEqual({ kind: 'code', code: `${PREFIX}abc` })
  })

  it('refuses a code of another kind', () => {
    expect(checkCode(PREFIX, 'hachiman-link:1:abc')).toEqual({ kind: 'wrong' })
    expect(checkCode(PREFIX, 'https://example.com')).toEqual({ kind: 'wrong' })
  })

  it('refuses empty text', () => {
    expect(checkCode(PREFIX, '')).toEqual({ kind: 'wrong' })
    expect(checkCode(PREFIX, '   ')).toEqual({ kind: 'wrong' })
  })
})
