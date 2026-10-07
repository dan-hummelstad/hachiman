import { describe, expect, it } from 'vitest'
import { countLabel, unreadMarkOf } from '@/lib/unread-mark'

describe('countLabel', () => {
  it('caps at 99+', () => {
    expect(countLabel(7)).toBe('7')
    expect(countLabel(99)).toBe('99')
    expect(countLabel(100)).toBe('99+')
  })
})

describe('unreadMarkOf', () => {
  it('shows mentions first, then the unread dot', () => {
    expect(unreadMarkOf({ mentions: 2, unread: true })).toEqual({
      kind: 'count',
      label: '2',
      aria: '2 mentions'
    })
    expect(unreadMarkOf({ mentions: 0, unread: true })).toEqual({ kind: 'dot' })
    expect(unreadMarkOf({ mentions: 0, unread: false })).toBeNull()
  })
  it('drops the dot or the number on request', () => {
    expect(unreadMarkOf({ mentions: 0, unread: true }, { dot: false })).toBeNull()
    expect(unreadMarkOf({ mentions: 1, unread: true }, { count: false })).toEqual({
      kind: 'mentionDot',
      aria: '1 mention'
    })
  })
})
