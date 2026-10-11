import type {} from '@redux-devtools/extension'
import { useCallback, useState } from 'react'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { CreateChannelBody } from '@hachiman/client'

/** The app-level modals before E2EE. Settings are not dialogs: see `openSettings` (navStore). */
type AppDialog =
  | { kind: 'addGuild' }
  | { kind: 'joinInvite'; code: string }
  | {
      kind: 'createChannel'
      guildId: string
      type: CreateChannelBody['type']
      parentId: string | null
    }
  | { kind: 'deleteChannel'; channelId: string }
  | { kind: 'removeGuild'; guildId: string }
  | { kind: 'invite'; guildId: string }
  /** Create (eventId null) or edit a guild event (N14). */
  | { kind: 'guildEvent'; guildId: string; eventId: string | null }
  /** N12: a thread on a message of `parentId`, `name` prefilled. */
  | { kind: 'createThread'; parentId: string; startMessageId: string; name: string }
  /** N9: the notification level and mute of a guild. */
  | { kind: 'notifySettings'; guildId: string }
  /** The sent time, encryption and delivery details of one message. */
  | { kind: 'messageInfo'; channelId: string; messageId: string }
  /** Sign out of this device: the red row of the mobile settings list (M29). */
  | { kind: 'signOut' }

/**
 * The E2EE dialogs (§12.4, §12.5, §12.10, §12.11). No payload holds a secret: a dialog that shows
 * a recovery key gets it from CryptoService and keeps it in component state.
 */
export type SecurityDialog =
  /** Set up, link or restore the identity of this device. */
  | { kind: 'securitySetup'; mode: 'choose' | 'setup' | 'link' | 'restore' | 'reset' }
  /** Make a new recovery key (rotateRecoveryKey) and show it once. */
  | { kind: 'recoveryKey' }
  /** Device linking. The new device shows a QR code or SAS emoji; the existing device scans or compares. */
  | { kind: 'deviceLink'; role: 'new_device' | 'existing_device'; sessionId: string | null }
  /** The safety number and QR code of one contact. */
  | { kind: 'verification'; userId: string }
  /** A contact's master key changed. 'blocking' for a verified contact. */
  | { kind: 'keyChange'; userId: string; severity: 'blocking' | 'notice' }
  /** The own device list (rename, revoke, sign out of this device). */
  | { kind: 'devices' }
  /** The epoch code of the current call and the participants from the MLS tree. */
  | { kind: 'verifyCall' }

/** Every app-level modal/overlay. At most one is open at a time. */
export type Dialog = AppDialog | SecurityDialog

/**
 * The kinds that shell/dialogs.tsx maps to components (`Record<DialogKind, …>`). The security
 * kinds join it when ui-identity and ui-voice register their components there:
 * `Record<DialogKind | SecurityDialogKind, …>`.
 */
export type DialogKind = AppDialog['kind']
export type SecurityDialogKind = SecurityDialog['kind']
/** Every kind that `openDialog` and `useDialog` take. */
export type AnyDialogKind = Dialog['kind']

/** An open dialog: its request plus a per-open id (a reopen of the same request gets a new one). */
export type OpenDialog = Dialog & { id: number }
export type DialogOf<K extends AnyDialogKind> = Extract<Dialog, { kind: K }> & { id: number }

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
export function useDialogOf<K extends AnyDialogKind>(kind: K): DialogOf<K> | null {
  return useDialogStore((s) => (s.dialog?.kind === kind ? (s.dialog as DialogOf<K>) : null))
}

/**
 * For a dialog component mounted by `<Dialogs/>`, which mounts one instance per open: the dialog
 * this instance was opened with (kept while it animates closed), whether it is still open, and
 * `close`, which closes only this open — so a request finishing after another dialog replaced
 * this one leaves the newer one alone.
 */
export function useDialog<K extends AnyDialogKind>(
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
