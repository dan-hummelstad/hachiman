import { expect, it } from 'vitest'
import { defaultThreadName, validThreadName } from './thread-name'

it('takes the first words up to the limit', () => {
  expect(defaultThreadName('can you set up the bracket for thursday? you have the admin')).toBe(
    'can you set up the bracket for thursday?'
  )
  expect(defaultThreadName('  bracket   seeding  ')).toBe('bracket seeding')
})

it('cuts one long word and falls back on empty text', () => {
  expect(defaultThreadName('x'.repeat(60))).toBe('x'.repeat(40))
  expect(defaultThreadName('')).toBe('New thread')
  expect(defaultThreadName('<@u1>')).toBe('New thread')
})

it('drops mention tokens', () => {
  expect(defaultThreadName('<@u1> seeding plan')).toBe('seeding plan')
})

it('validates the server length', () => {
  expect(validThreadName('  a  ')).toBe('a')
  expect(validThreadName('   ')).toBeNull()
  expect(validThreadName('x'.repeat(101))).toBeNull()
})
