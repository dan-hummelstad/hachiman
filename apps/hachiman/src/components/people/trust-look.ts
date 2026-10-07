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
