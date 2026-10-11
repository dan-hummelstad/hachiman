import { create } from 'zustand'
import type { PresenceStatus } from '@hachiman/client'

/** The presence choices of my own status, in menu order. `offline` is "Invisible". */
export const STATUSES: readonly PresenceStatus[] = ['online', 'idle', 'dnd', 'offline']

export const isStatus = (v: string): v is PresenceStatus =>
  (STATUSES as readonly string[]).includes(v)

/** Which of the two sheets shows: the status choice, or "Set a status" in its place. */
export type StatusSheetOpen = 'status' | 'custom'

/** The open sheet of `components/settings/status-sheet.tsx`. In memory only. */
export const useStatusSheetStore = create<{ open: StatusSheetOpen | null }>()(() => ({
  open: null
}))

/** The status chip of the mobile settings list (M29) opens the status sheet. */
export const openStatusSheet = (): void => useStatusSheetStore.setState({ open: 'status' })

/** "Set a status" replaces the status sheet. */
export const openCustomStatusSheet = (): void => useStatusSheetStore.setState({ open: 'custom' })

/** Closes `which` only if it still shows: "Set a status" replaces the status sheet as it closes. */
export const closeStatusSheet = (which: StatusSheetOpen): void =>
  useStatusSheetStore.setState((s) => (s.open === which ? { open: null } : s))
