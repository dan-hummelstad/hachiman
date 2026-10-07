import { describe, expect, it } from 'vitest'
import { countOnline } from '@/lib/online-count'

describe('countOnline', () => {
  const presences = new Map([
    ['a', 'online'],
    ['b', 'idle'],
    ['c', 'offline'],
    ['me', 'online']
  ])
  it('counts every presence that is not offline', () => {
    expect(countOnline(['a', 'b', 'c', 'd'], presences)).toBe(2)
  })
  it('leaves out me', () => {
    expect(countOnline(presences.keys(), presences, 'me')).toBe(2)
  })
})
