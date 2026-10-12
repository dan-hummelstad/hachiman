import { expect, it } from 'vitest'
import { resolveTheme } from './theme'

it('keeps an explicit theme whatever the OS says', () => {
  expect(resolveTheme('dark', false)).toBe('dark')
  expect(resolveTheme('light', true)).toBe('light')
})

it('follows the OS for system', () => {
  expect(resolveTheme('system', true)).toBe('dark')
  expect(resolveTheme('system', false)).toBe('light')
})
