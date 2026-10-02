import type {} from '@redux-devtools/extension'
import { useCallback, useState } from 'react'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { CreateChannelBody } from '@hachiman/client'

/** Every app-level modal/overlay. At most one is open at a time. */
export type Dialog =
  | { kind: 'addGuild' }
  | { kind: 'joinInvite'; code: string }
  | { kind: 'guildSettings'; guildId: string }
  | { kind: 'channelSettings'; channelId: string }
  | {
      kind: 'createChannel'
      guildId: string
      type: CreateChannelBody['type']
      parentId: string | null
    }
  | { kind: 'deleteChannel'; channelId: string }
  | { kind: 'removeGuild'; guildId: string }
  | { kind: 'invite'; guildId: string }
  | { kind: 'userSettings' }

export type DialogKind = Dialog['kind']

/** An open dialog: its request plus a per-open id (a reopen of the same request gets a new one). */
export type OpenDialog = Dialog & { id: number }
export type DialogOf<K extends DialogKind> = Extract<Dialog, { kind: K }> & { id: number }

interface DialogState {
  dialog: OpenDialog | null
  openDialog: (dialog: Dialog) => void
  /** Close the dialog opened as `id`; a no-op once another open has replaced it. */
  closeDialog: (id: number) => void
  /** Close whatever is open (sign-out). */
  closeAllDialogs: () => void
}

let lastId = 0

export const useDialogStore = create<DialogState>()(
  devtools((set) => ({
    dialog: null,
    openDialog: (dialog) => set({ dialog: { ...dialog, id: ++lastId } }),
    closeDialog: (id) => set((s) => (s.dialog?.id === id ? { dialog: null } : s)),
    closeAllDialogs: () => set({ dialog: null })
  }))
)

export const openDialog = (dialog: Dialog): void => useDialogStore.getState().openDialog(dialog)
export const closeAllDialogs = (): void => useDialogStore.getState().closeAllDialogs()

/** The open dialog if it is of `kind` (same object reference while open), else null. */
export function useDialogOf<K extends DialogKind>(kind: K): DialogOf<K> | null {
  return useDialogStore((s) => (s.dialog?.kind === kind ? (s.dialog as DialogOf<K>) : null))
}

/**
 * For a dialog component mounted by `<Dialogs/>`, which mounts one instance per open: the dialog
 * this instance was opened with (kept while it animates closed), whether it is still open, and
 * `close`, which closes only this open — so a request finishing after another dialog replaced
 * this one leaves the newer one alone.
 */
export function useDialog<K extends DialogKind>(
  kind: K
): { dialog: DialogOf<K>; open: boolean; close: () => void } {
  const live = useDialogOf(kind)
  const [opened] = useState(live)
  const id = opened?.id
  const close = useCallback(() => {
    if (id !== undefined) useDialogStore.getState().closeDialog(id)
  }, [id])
  if (!opened) throw new Error(`The ${kind} dialog was mounted while closed`)
  return { dialog: opened, open: live?.id === opened.id, close }
}
