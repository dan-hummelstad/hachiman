import { describe, expect, it } from 'vitest'
import { previewOptionsFromQuery, type PreviewOptions } from './options'

const parse = (search: string): PreviewOptions =>
  previewOptionsFromQuery(new URLSearchParams(search))

describe('previewOptionsFromQuery', () => {
  it('gives the defaults for a bare ?preview', () => {
    expect(parse('?preview')).toEqual({
      signedOut: false,
      theme: undefined,
      messageDisplay: undefined
    })
  })

  it('reads ?preview=signedout', () => {
    expect(parse('?preview=signedout').signedOut).toBe(true)
    expect(parse('?preview=other').signedOut).toBe(false)
  })

  it('passes light and system themes and drops the others', () => {
    expect(parse('?preview&theme=light').theme).toBe('light')
    expect(parse('?preview&theme=system').theme).toBe('system')
    expect(parse('?preview&theme=dark').theme).toBeUndefined()
    expect(parse('?preview&theme=bogus').theme).toBeUndefined()
  })

  it('passes compact and cozy display and drops the others', () => {
    expect(parse('?preview&display=compact').messageDisplay).toBe('compact')
    expect(parse('?preview&display=cozy').messageDisplay).toBe('cozy')
    expect(parse('?preview&display=wide').messageDisplay).toBeUndefined()
  })
})
