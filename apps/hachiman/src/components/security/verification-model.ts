import type { DevicePlatform, SenderTrust } from '@hachiman/crypto'
import { DEVICE_NAME } from '@/lib/device-platform'

/** One line of the safety number box: its groups, and the text that a screen reader reads. */
export interface SafetyRow {
  groups: string[]
  label: string
}

/**
 * The 12 groups of a safety number as rows of `perRow` (3 rows of 4 on the phone). The label
 * spells each digit ("0 8 4 6 5"), so VoiceOver keeps a leading zero and reads digits to compare,
 * not a number.
 */
export function safetyRows(groups: readonly string[], perRow = 4): SafetyRow[] {
  const count = Math.ceil(groups.length / perRow)
  return Array.from({ length: count }, (_, i) => {
    const row = groups.slice(i * perRow, (i + 1) * perRow)
    const spelled = row.map((g) => g.split('').join(' ')).join(', ')
    return { groups: row, label: `Row ${i + 1} of ${count}: ${spelled}` }
  })
}

/** A button at the foot of the verification sheet. */
export type FootAction = 'acceptKey' | 'removeVerification' | 'scan' | 'cancelScan' | 'markVerified'

/**
 * The buttons at the foot of the verification sheet, top to bottom. The primary action is last, so
 * it sits at the bottom in thumb reach. "Remove verification" goes above "Scan their code", so a
 * tap at the bottom never removes a verification. While the scan panel shows, only Cancel.
 */
export function verificationFoot(state: SenderTrust | null, scanning: boolean): FootAction[] {
  if (scanning) return ['cancelScan']
  if (state === 'verified') return ['removeVerification', 'scan']
  if (state === 'changed') return ['acceptKey', 'scan', 'markVerified']
  return ['scan', 'markVerified']
}

/**
 * The platform of each certificate name that this app gives a new device (`DEVICE_NAME`). A
 * contact's device carries only its signed name, no platform.
 */
const PLATFORM_OF_NAME = new Map<string, DevicePlatform>(
  Object.entries(DEVICE_NAME).map(([platform, name]) => [name, platform as DevicePlatform])
)

/** The platform of a contact's device, from its certificate name. Null: a name this app did not give. */
export function contactDevicePlatform(displayName: string): DevicePlatform | null {
  return PLATFORM_OF_NAME.get(displayName) ?? null
}
