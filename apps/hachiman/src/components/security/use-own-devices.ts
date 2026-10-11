import { useCallback, useEffect, useState } from 'react'
import type { DeviceSummary } from '@hachiman/crypto'
import { cryptoErrorText } from '@/components/security/errors'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/hachiman'

/**
 * The own devices of the user from the Worker. Reloads on USER_KEYS_UPDATE for the own user.
 * `enabled` false loads nothing (the Worker is not ready).
 */
export function useOwnDevices(enabled = true): {
  devices: DeviceSummary[] | null
  error: string | null
  reload: () => void
} {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    Promise.resolve()
      .then(() => cryptoService.client().listDevices())
      .then(
        (d) => {
          setDevices(d)
          setError(null)
        },
        (e: unknown) => setError(cryptoErrorText(e))
      )
  }, [])
  useEffect(() => {
    if (!enabled) return undefined
    reload()
    const onKeys = ({ userId }: { userId: string }): void => {
      if (userId === hachiman.cache.user?.id) reload()
    }
    hachiman.on('USER_KEYS_UPDATE', onKeys)
    return () => {
      hachiman.off('USER_KEYS_UPDATE', onKeys)
    }
  }, [reload, enabled])
  return { devices, error, reload }
}
