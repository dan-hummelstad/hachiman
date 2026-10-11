import { expect, it } from 'vitest'
import { layoutOf } from './use-layout'

const none = { ios: false, narrow: false, shortTouch: false }

it('is desktop in a wide window on a desktop host', () => {
  expect(layoutOf(none)).toBe('desktop')
})

it('is mobile on the iOS host at any width', () => {
  expect(layoutOf({ ...none, ios: true })).toBe('mobile')
})

it('is mobile in a narrow window and on a phone in landscape', () => {
  expect(layoutOf({ ...none, narrow: true })).toBe('mobile')
  expect(layoutOf({ ...none, shortTouch: true })).toBe('mobile')
})
