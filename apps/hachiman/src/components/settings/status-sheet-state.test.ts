import { beforeEach, expect, it } from 'vitest'
import {
  closeStatusSheet,
  isStatus,
  openCustomStatusSheet,
  openStatusSheet,
  useStatusSheetStore
} from './status-sheet-state'

beforeEach(() => useStatusSheetStore.setState({ open: null }))

it('lets "Set a status" replace the status sheet as it closes', () => {
  openStatusSheet()
  expect(useStatusSheetStore.getState().open).toBe('status')
  // The menu sheet runs the row's onSelect, then closes itself.
  openCustomStatusSheet()
  closeStatusSheet('status')
  expect(useStatusSheetStore.getState().open).toBe('custom')
  closeStatusSheet('custom')
  expect(useStatusSheetStore.getState().open).toBeNull()
})

it('knows the four presence choices', () => {
  expect(['online', 'idle', 'dnd', 'offline'].every(isStatus)).toBe(true)
  expect(isStatus('invisible')).toBe(false)
})
