import { describe, expect, it } from 'vitest'
import { stripFit, stripSlots } from './icon-strip'

describe('stripSlots', () => {
  it('counts the items that fit, the last one without a gap after it', () => {
    expect(stripSlots(252, 26, 10)).toBe(7)
    expect(stripSlots(26, 26, 10)).toBe(1)
    expect(stripSlots(25, 26, 10)).toBe(0)
    expect(stripSlots(0, 26, 10)).toBe(0)
  })
})

describe('stripFit', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']

  it('shows everything when it fits, with no "more" item', () => {
    expect(stripFit(ids, 5, null)).toEqual({ shown: ids, hidden: [], more: false })
  })

  it('counts the tail as a place', () => {
    expect(stripFit(ids, 6, null, true).more).toBe(false)
    expect(stripFit(ids, 5, null, true)).toEqual({
      shown: ['a', 'b', 'c', 'd'],
      hidden: ['e'],
      more: true
    })
  })

  it('gives the last place to the "more" item', () => {
    expect(stripFit(ids, 3, null)).toEqual({
      shown: ['a', 'b'],
      hidden: ['c', 'd', 'e'],
      more: true
    })
  })

  it('keeps the selected item in view in the last item place', () => {
    expect(stripFit(ids, 3, 'e')).toEqual({
      shown: ['a', 'e'],
      hidden: ['b', 'c', 'd'],
      more: true
    })
    expect(stripFit(ids, 3, 'a').shown).toEqual(['a', 'b'])
    expect(stripFit(ids, 3, 'x').shown).toEqual(['a', 'b'])
  })

  it('shows only the "more" item when there is one place', () => {
    expect(stripFit(ids, 1, 'c')).toEqual({ shown: [], hidden: ids, more: true })
    expect(stripFit(ids, 0, null).more).toBe(true)
  })
})
