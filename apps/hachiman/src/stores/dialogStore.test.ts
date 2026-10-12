import { beforeEach, expect, it } from 'vitest'
import { openDialog, useDialogStore } from './dialogStore'

beforeEach(() => useDialogStore.setState({ dialog: null }))

it('lets "Set a status" replace the status sheet as it closes', () => {
  openDialog({ kind: 'status' })
  const status = useDialogStore.getState().dialog
  expect(status?.kind).toBe('status')
  // The menu sheet runs the row's onSelect, then closes itself.
  openDialog({ kind: 'customStatus' })
  useDialogStore.getState().closeDialog(status!.id)
  const custom = useDialogStore.getState().dialog
  expect(custom?.kind).toBe('customStatus')
  useDialogStore.getState().closeDialog(custom!.id)
  expect(useDialogStore.getState().dialog).toBeNull()
})
