import { useEffect, useState, useSyncExternalStore } from 'react'
import type { TrustInfo } from '@hachiman/crypto'
import { cryptoErrorText } from '@/components/security/errors'
import { cryptoService } from '@/services/CryptoService'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useDialogStore } from '@/stores/dialogStore'

let version = 0
const listeners = new Set<() => void>()
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const getVersion = (): number => version

/** Every useContactTrust reads its trust again: call it after setVerified, verifyQr or an acknowledge. */
export function invalidateTrust(): void {
  version++
  for (const l of listeners) l()
}

export interface ContactTrust {
  /** null while it loads, or when the Worker cannot answer (then `error` is set). */
  trust: TrustInfo | null
  error: string | null
}

/**
 * The trust of one contact, from the crypto Worker (trust is per user, decision 5). It reads again
 * when the Worker becomes ready, when a key change for the user arrives or goes away, when the
 * verification dialog opens or closes, and on invalidateTrust(). The last answer stays shown while
 * it reads again, so a chip does not blink.
 */
export function useContactTrust(userId: string | undefined): ContactTrust {
  const ready = useCryptoStore((s) => s.phase === 'ready')
  const keyChange = useCryptoStore((s) => s.keyChanges.some((k) => k.userId === userId))
  const verifying = useDialogStore((s) => s.dialog?.kind === 'verification')
  const v = useSyncExternalStore(subscribe, getVersion)
  const [result, setResult] = useState<{ userId: string } & ContactTrust>()

  useEffect(() => {
    if (!userId || !ready) return
    let live = true
    Promise.resolve()
      .then(() => cryptoService.client().getTrust(userId))
      .then(
        (trust) => live && setResult({ userId, trust, error: null }),
        (e: unknown) => live && setResult({ userId, trust: null, error: cryptoErrorText(e) })
      )
    return () => {
      live = false
    }
  }, [userId, ready, keyChange, verifying, v])

  if (!ready) return { trust: null, error: 'Security keys are not ready yet.' }
  if (!result || result.userId !== userId) return { trust: null, error: null }
  return { trust: result.trust, error: result.error }
}
