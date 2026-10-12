import { ShieldAlert, ShieldCheck, ShieldQuestion, type LucideIcon } from 'lucide-react'
import type { SenderTrust } from '@hachiman/crypto'

export interface TrustLook {
  label: string
  Icon: LucideIcon
  /** Text color of the state. */
  text: string
  /** Border and wash of a card in the state. */
  card: string
  /** Wash and text color of a chip in the state. */
  chip: string
  /** The user can compare safety numbers: the contact has a key and is not verified. */
  canVerify: boolean
}

/**
 * The one look of each trust state (§12.5, decision 5: trust is per user). The Worker gives
 * 'unknown' only when the user has no security key (getTrust fetches the keys first), so that
 * state reads "No key yet" and has no Verify action. A user with a key is 'tofu' until verified.
 */
export const TRUST_LOOK: Record<SenderTrust, TrustLook> = {
  verified: {
    label: 'Verified',
    Icon: ShieldCheck,
    text: 'text-feature-voice-text',
    card: 'border-feature-voice/40 bg-feature-voice/10',
    chip: 'bg-feature-voice/15 text-feature-voice-text',
    canVerify: false
  },
  tofu: {
    label: 'Not verified',
    Icon: ShieldQuestion,
    text: 'text-feature-event-text',
    card: 'border-feature-event/40 bg-feature-event/10',
    chip: 'bg-feature-event/15 text-feature-event-text',
    canVerify: true
  },
  changed: {
    label: 'Key changed',
    Icon: ShieldAlert,
    text: 'text-feature-danger-text',
    card: 'border-feature-danger/50 bg-feature-danger/10',
    chip: 'bg-feature-danger/15 text-feature-danger-text',
    canVerify: true
  },
  unknown: {
    label: 'No key yet',
    Icon: ShieldQuestion,
    text: 'text-text-tertiary',
    card: 'border-line-hairline',
    chip: 'bg-surface-raised text-text-tertiary',
    canVerify: false
  }
}

/**
 * The severity of a pending key change (the Worker's `keyChange` event): 'blocking' for a contact
 * that was verified, 'notice' for one that was not (§12.5 TOFU).
 */
export type KeyChangeSeverity = 'blocking' | 'notice'

/**
 * The state that a contact shows. A 'notice' key change (the contact was never verified) shows
 * as 'tofu', gold "Not verified" (E6). A 'blocking' change shows as 'changed', red. So does a
 * change whose severity this device does not know: the event lives in memory only.
 */
export function shownTrust(state: SenderTrust, keyChange?: KeyChangeSeverity | null): SenderTrust {
  return state === 'changed' && keyChange === 'notice' ? 'tofu' : state
}

/** The look of a trust state with its pending key change (`shownTrust`). */
export function lookFor(state: SenderTrust, keyChange?: KeyChangeSeverity | null): TrustLook {
  return TRUST_LOOK[shownTrust(state, keyChange)]
}

/** What `securityText` needs. `state` null: the trust still loads. */
export interface SecurityTextInput {
  name: string
  state: SenderTrust | null
  keyChange?: KeyChangeSeverity | null
  /** The day of the verification as the caller shows it, or null. */
  verifiedOn: string | null
  /** The Worker cannot answer. */
  error: string | null
}

/**
 * The explainer of a contact's security key: the security card of the profile column and the
 * key card of the DM intro say the same.
 */
export function securityText({
  name,
  state,
  keyChange,
  verifiedOn,
  error
}: SecurityTextInput): string {
  if (error !== null) return 'The security key cannot be read now.'
  if (state === null) return 'Reading the security key…'
  switch (state) {
    case 'verified':
      return `You compared safety numbers${verifiedOn ? ` on ${verifiedOn}` : ''}. Hachiman will tell you if this key ever changes.`
    case 'changed':
      return keyChange === 'notice'
        ? `${name} has a new security key. Compare safety numbers once, in person or on a call, so nobody can sit in between.`
        : `The security key of ${name} changed. Compare safety numbers again.`
    case 'tofu':
      return 'Compare safety numbers once, in person or on a call, so nobody can sit in between.'
    case 'unknown':
      return `Hachiman has no security key for ${name} yet.`
  }
}

/**
 * The accessible name of the icon-only trust button of the mobile DM header: the state, its
 * day, and what a tap does.
 */
export function trustButtonLabel({
  name,
  state,
  keyChange,
  verifiedOn
}: Omit<SecurityTextInput, 'state' | 'error'> & { state: SenderTrust }): string {
  switch (shownTrust(state, keyChange)) {
    case 'verified':
      return `Verified${verifiedOn ? ` on ${verifiedOn}` : ''}. Safety numbers of ${name}`
    case 'tofu':
      return `Not verified. Verify ${name}`
    case 'changed':
      return `Key changed. Verify ${name} again`
    case 'unknown':
      return `${name} has no security key yet`
  }
}
