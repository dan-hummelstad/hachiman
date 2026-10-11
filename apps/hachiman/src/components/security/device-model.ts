import { useCallback } from 'react'
import type { DeviceSummary, RevocationReasonName } from '@hachiman/crypto'
import { friendly } from '@/components/security/errors'
import { useAction } from '@/hooks/use-action'
import { PLATFORM_LABEL } from '@/lib/device-platform'
import { calendarDaysAgo, formatDayMonthYear, relativeTime } from '@/lib/time-format'
import { cryptoService } from '@/services/CryptoService'

/**
 * The words and actions of the own devices that both layouts share: the desktop `DevicesPanel`
 * and the mobile devices screen (M25) with its device sheet (M26).
 */

/** The reasons that a user can give to sign out another device (§12.12). */
export type RemoveReason = Exclude<RevocationReasonName, 'password_reset' | 'signed_out'>

export const PRIMARY_ONLY =
  'Only a device with your security key can sign out other devices: your first device, or a device that you restored with the recovery key.'

const ACTIVE_NOW_MS = 5 * 60_000

/** "active now", "active 2 hours ago", "active yesterday". */
export function activeText(lastSeenAt: string, now: number): string {
  const seen = Date.parse(lastSeenAt)
  return now - seen < ACTIVE_NOW_MS ? 'active now' : `active ${relativeTime(lastSeenAt, now)}`
}

/**
 * The second line of a device row on the mobile layout (M25): the kind of app, then when it was
 * active. This device runs now, whatever the server last saw.
 */
export function deviceMeta(
  device: Pick<DeviceSummary, 'platform' | 'current' | 'lastSeenAt'>,
  now: number
): string {
  const active = device.current
    ? 'active now'
    : device.lastSeenAt && activeText(device.lastSeenAt, now)
  return active ? `${PLATFORM_LABEL[device.platform]} · ${active}` : PLATFORM_LABEL[device.platform]
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The "Last active" line of the device sheet (M26): "Now", "2 hours ago", "Yesterday". Null when
 * the server has not seen the device (a device that did not finish its link).
 */
export function lastActiveText(
  device: Pick<DeviceSummary, 'current' | 'lastSeenAt'>,
  now: number
): string | null {
  if (device.current) return 'Now'
  if (!device.lastSeenAt || !Number.isFinite(Date.parse(device.lastSeenAt))) return null
  const active = activeText(device.lastSeenAt, now)
  return active === 'active now' ? 'Now' : capitalize(relativeTime(device.lastSeenAt, now))
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * When a device was added, for the sheet subtitle (M26): "today", "yesterday" or the date
 * (`formatDayMonthYear`). A time in the future (clock skew) is today. Null for a broken time.
 */
export function addedDay(createdAt: string, now: number): string | null {
  const ms = Date.parse(createdAt)
  if (!Number.isFinite(ms)) return null
  const days = calendarDaysAgo(ms, now)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return formatDayMonthYear(ms, now)
}

/** The "Added" line of the device sheet (M26): "Today, 09:38", "Yesterday, 18:02" or the date. */
export function addedText(createdAt: string, now: number): string | null {
  const ms = Date.parse(createdAt)
  if (!Number.isFinite(ms)) return null
  const days = calendarDaysAgo(ms, now)
  if (days > 1) return formatDayMonthYear(ms, now)
  return `${days <= 0 ? 'Today' : 'Yesterday'}, ${CLOCK.format(ms)}`
}

/**
 * Rename a device: the REST name only, which only the user sees (§12.12). `rename` trims the
 * name. An empty or unchanged name renames nothing. A failure sets `error`.
 */
export function useRenameDevice(
  device: Pick<DeviceSummary, 'id' | 'name'>,
  onRenamed: () => void
): {
  rename: (name: string) => Promise<'renamed' | 'unchanged' | 'failed'>
  busy: boolean
  error: string | null
  clearError: () => void
} {
  const { run, busy, error, clearError } = useAction()
  const { id, name: current } = device
  const rename = useCallback(
    async (name: string): Promise<'renamed' | 'unchanged' | 'failed'> => {
      const next = name.trim()
      if (!next || next === current) return 'unchanged'
      const r = await run('rename the device', () =>
        friendly(cryptoService.client().renameDevice(id, next))
      )
      if (!r.ok) return 'failed'
      onRenamed()
      return 'renamed'
    },
    [run, id, current, onRenamed]
  )
  return { rename, busy, error, clearError }
}
