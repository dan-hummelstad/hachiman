import { useEffect } from 'react'
import { useLatched } from '@/hooks/use-latched'
import { useDialog, type DialogKind, type DialogOf } from '@/stores/dialogStore'

/**
 * `useDialog` for a dialog about one store entity (a guild, a channel…). `useEntity` is a hook
 * that reads the live entity for the dialog. `subject` keeps the last value seen so the window can
 * animate closed after the entity is gone; the dialog closes itself when the entity disappears
 * while open, and `open` is false while there is nothing to show.
 */
export function useDialogSubject<K extends DialogKind, T>(
  kind: K,
  useEntity: (dialog: DialogOf<K>) => T | undefined
): { dialog: DialogOf<K>; subject: T | null; open: boolean; close: () => void } {
  const { dialog, open, close } = useDialog(kind)
  const live = useEntity(dialog)
  const subject = useLatched(live)
  const gone = live === undefined

  useEffect(() => {
    if (open && gone) close()
  }, [open, gone, close])

  return { dialog, subject, open: open && !gone, close }
}
