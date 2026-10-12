import { expect, it } from 'vitest'
import { pickRequest } from './use-native-appearance'

const base = { background: 'var(--surface-window)', base: true }
const tint = { background: '#201c46', base: false }
const other = { background: '#0f2d2c', base: false }

it('uses the base when it is the only caller', () => {
  expect(pickRequest([base])).toBe(base)
})

it('lets a screen colour win over the base in any mount order', () => {
  expect(pickRequest([base, tint])).toBe(tint)
  expect(pickRequest([tint, base])).toBe(tint)
})

it('lets the latest screen colour win', () => {
  expect(pickRequest([base, tint, other])).toBe(other)
})

it('has nothing to send with no caller', () => {
  expect(pickRequest([])).toBeNull()
})
