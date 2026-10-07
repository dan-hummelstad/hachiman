/** The longest custom status text (N16). */
export const CUSTOM_STATUS_MAX = 64

export type ClearAfter = 'never' | '1h' | '4h' | 'today' | 'week'

export const CLEAR_AFTER_OPTIONS: readonly { value: ClearAfter; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '1h', label: '1 hour' },
  { value: '4h', label: '4 hours' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' }
]

const HOUR_MS = 3_600_000

/**
 * The RFC 3339 end time for a "clear after" choice, or null for "Never". "Today" ends at the next
 * local midnight. "This week" ends at the local midnight that starts next Monday.
 */
export function clearAfterToExpiresAt(choice: ClearAfter, now: Date): string | null {
  switch (choice) {
    case 'never':
      return null
    case '1h':
      return new Date(now.getTime() + HOUR_MS).toISOString()
    case '4h':
      return new Date(now.getTime() + 4 * HOUR_MS).toISOString()
    case 'today':
      return localMidnightAfter(now, 1).toISOString()
    case 'week': {
      // getDay: 0 is Sunday. Days until next Monday: Monday → 7, Sunday → 1.
      const days = (8 - now.getDay()) % 7 || 7
      return localMidnightAfter(now, days).toISOString()
    }
  }
}

function localMidnightAfter(now: Date, days: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
}
