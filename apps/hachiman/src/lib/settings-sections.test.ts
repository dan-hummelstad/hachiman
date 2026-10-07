import { describe, expect, it } from 'vitest'
import { isVisible, resolveSection } from '@/lib/settings-sections'

const groups = [
  { items: [{ id: 'account' }] },
  {
    items: [
      { id: 'devices', visible: false },
      { id: 'appearance', visible: true }
    ]
  }
]

describe('resolveSection', () => {
  it('takes a visible picked row', () => {
    expect(resolveSection(groups, 'appearance')?.id).toBe('appearance')
  })
  it('falls back to the first visible row for a hidden or unknown pick', () => {
    expect(resolveSection(groups, 'devices')?.id).toBe('account')
    expect(resolveSection(groups, 'nope')?.id).toBe('account')
    expect(resolveSection(groups, null)?.id).toBe('account')
  })
  it('is undefined when nothing shows', () => {
    expect(resolveSection([{ items: [{ id: 'a', visible: false }] }], 'a')).toBeUndefined()
  })
})

describe('isVisible', () => {
  it('defaults to visible', () => {
    expect(isVisible({ id: 'x' })).toBe(true)
    expect(isVisible({ id: 'x', visible: false })).toBe(false)
  })
})
