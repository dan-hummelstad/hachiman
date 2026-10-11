import { expect, it } from 'vitest'
import { holdEndOpensMenu, isTouchDrag } from './use-sortable-row'

const touchStart = { type: 'touchstart', touches: [] } as unknown as Event
const mouseDown = { type: 'mousedown' } as unknown as Event

it('tells a touch drag from a mouse drag by its activator event', () => {
  expect(isTouchDrag(touchStart)).toBe(true)
  expect(isTouchDrag(mouseDown)).toBe(false)
  expect(isTouchDrag(null)).toBe(false)
})

it('opens the hold menu when a touch drag ends where it started', () => {
  expect(holdEndOpensMenu(true, { x: 0, y: 0 })).toBe(true)
  expect(holdEndOpensMenu(true, { x: 5, y: -6 })).toBe(true)
})

it('reorders, not opens the menu, when the finger moved', () => {
  expect(holdEndOpensMenu(true, { x: 9, y: 0 })).toBe(false)
  expect(holdEndOpensMenu(true, { x: 0, y: 40 })).toBe(false)
})

it('never opens the hold menu at the end of a mouse drag', () => {
  expect(holdEndOpensMenu(false, { x: 0, y: 0 })).toBe(false)
})
