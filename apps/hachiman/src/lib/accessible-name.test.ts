import { describe, expect, it } from 'vitest'
import { NAME_MAX, accessibleName, type NamedElement } from './accessible-name'

function el(attrs: Record<string, string>, text: string | null = null): NamedElement {
  return { getAttribute: (name) => attrs[name] ?? null, textContent: text }
}

const none = (): NamedElement | null => null

describe('accessibleName', () => {
  it('is null for no element or an element with no name', () => {
    expect(accessibleName(null, none)).toBeNull()
    expect(accessibleName(el({}, '  \n '), none)).toBeNull()
  })

  it('takes aria-label first', () => {
    expect(accessibleName(el({ 'aria-label': ' More ' }, 'ignored'), none)).toBe('More')
  })

  it('takes the aria-labelledby texts in order, joined by one space', () => {
    const doc: Record<string, NamedElement> = {
      a: el({}, 'Night'),
      b: el({}, ' Owls\n')
    }
    expect(
      accessibleName(el({ 'aria-labelledby': 'a  b missing' }, 'x'), (id) => doc[id] ?? null)
    ).toBe('Night Owls')
  })

  it('falls back to the own text when the label and the labelledby texts are empty', () => {
    expect(
      accessibleName(el({ 'aria-label': ' ', 'aria-labelledby': 'gone' }, ' general\n 3 '), none)
    ).toBe('general 3')
  })

  it('cuts a long name with an ellipsis', () => {
    const name = accessibleName(el({}, 'word '.repeat(40)), none)
    expect(name).not.toBeNull()
    expect(name!.length).toBeLessThanOrEqual(NAME_MAX)
    expect(name!.endsWith('…')).toBe(true)
  })
})
