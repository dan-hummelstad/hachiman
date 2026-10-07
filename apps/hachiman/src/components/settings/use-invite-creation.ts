import { useState } from 'react'
import { isInviteExpiryChoice } from '@/components/settings/invites'
import type { Action } from '@/hooks/use-action'
import { DEFAULT_INVITE_OPTIONS, type InviteOptionsValue } from '@/services/InviteService'

/**
 * The options of a "create invite" form and the permanent-invite gate (contract §4 "Invite limits"):
 * expiry 0 opens the warning, and only its confirm creates the invite, with the acknowledgment.
 * `run` and `what` give the busy state and the error text of a create without the warning.
 */
export function useInviteCreation<T>({
  isAdmin,
  run,
  what,
  make,
  onCreated
}: {
  isAdmin: boolean
  run: Action['run']
  what: string
  make: (o: InviteOptionsValue, acknowledgedPermanent: boolean) => Promise<T>
  onCreated: (made: T) => void
}): {
  options: InviteOptionsValue
  setOptions: (o: InviteOptionsValue) => void
  create: () => Promise<void>
  /** The props of `PermanentInviteConfirm`. */
  confirm: { open: boolean; onClose: () => void; onConfirm: () => Promise<void> }
} {
  const [options, setOptions] = useState(DEFAULT_INVITE_OPTIONS)
  const [confirmingPermanent, setConfirmingPermanent] = useState(false)

  // The user can lose ADMINISTRATOR while the form is open: fall back to a choice they still have.
  // Keep this a state reset, not derived state: a user who gets ADMINISTRATOR back must not see
  // "Permanent" and the warning come back.
  if (!isInviteExpiryChoice(options.expiry, isAdmin)) {
    setOptions({ ...options, expiry: DEFAULT_INVITE_OPTIONS.expiry })
    setConfirmingPermanent(false)
  }

  const create = async (): Promise<void> => {
    if (options.expiry === 0) {
      setConfirmingPermanent(true)
      return
    }
    const made = await run(what, () => make(options, false))
    if (made.ok) onCreated(made.value)
  }

  return {
    options,
    setOptions,
    create,
    confirm: {
      open: confirmingPermanent,
      onClose: () => setConfirmingPermanent(false),
      onConfirm: async () => onCreated(await make(options, true))
    }
  }
}
