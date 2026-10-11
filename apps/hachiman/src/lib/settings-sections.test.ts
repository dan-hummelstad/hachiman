import { describe, expect, it } from 'vitest'
import { isVisible, listedGroups, listedPageId, resolveSection } from '@/lib/settings-sections'

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

const paged = [
  { heading: 'Overview', items: [{ id: 'overview', page: 'o' }] },
  {
    heading: 'Manage',
    items: [{ id: 'roles', page: 'r' }, { id: 'audit', visible: false, page: 'a' }, { id: 'leave' }]
  }
]

describe('listedPageId', () => {
  it('shows the list for no section', () => {
    expect(listedPageId(paged, null, undefined)).toBeNull()
  })
  it('shows the list for an unknown or hidden section', () => {
    expect(listedPageId(paged, 'nope', undefined)).toBeNull()
    expect(listedPageId(paged, 'audit', undefined)).toBeNull()
  })
  it('shows the list for the inline section', () => {
    expect(listedPageId(paged, 'overview', 'overview')).toBeNull()
  })
  it('shows the list for a row without a page', () => {
    expect(listedPageId(paged, 'leave', undefined)).toBeNull()
  })
  it('pushes the page of a visible row', () => {
    expect(listedPageId(paged, 'roles', 'overview')).toBe('roles')
    expect(listedPageId(paged, 'overview', undefined)).toBe('overview')
  })
})

describe('listedGroups', () => {
  it('leaves out hidden rows and the inline row', () => {
    expect(listedGroups(paged, undefined).map((g) => g.items.map((s) => s.id))).toEqual([
      ['overview'],
      ['roles', 'leave']
    ])
  })
  it('leaves out a group with no rows left, and keeps the headings', () => {
    const groups = listedGroups(paged, 'overview')
    expect(groups.map((g) => g.heading)).toEqual(['Manage'])
    expect(groups[0]?.items.map((s) => s.id)).toEqual(['roles', 'leave'])
  })
})
