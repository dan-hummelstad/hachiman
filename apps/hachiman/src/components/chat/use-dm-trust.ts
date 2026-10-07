import { useEffect, useState } from 'react'
import type { SenderTrust } from '@hachiman/crypto'
import { cryptoService } from '@/services/CryptoService'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useDialogStore } from '@/stores/dialogStore'

export type TrustBadge = 'verified' | 'unverified' | 'changed'

const BADGE: Record<SenderTrust, TrustBadge> = {
  verified: 'verified',
  tofu: 'unverified',
  unknown: 'unverified',
  changed: 'changed'
}

/**
 * The trust badge of one contact (trust is per user, plan decision 5), or null while unknown.
 * It reads again when a key change arrives for the user and when a dialog closes (the user may
 * have verified or accepted a key in it).
 */
export function useTrustBadge(userId: string | undefined): TrustBadge | null {
  const keyChanged = useCryptoStore((s) => s.keyChanges.some((k) => k.userId === userId))
  const dialogOpen = useDialogStore((s) => s.dialog !== null)
  const [trust, setTrust] = useState<{ userId: string; state: SenderTrust } | null>(null)
  useEffect(() => {
    if (!userId || dialogOpen) return
    let live = true
    Promise.resolve()
      .then(() => cryptoService.client().getTrust(userId))
      .then(
        (t) => live && setTrust({ userId, state: t.state }),
        () => live && setTrust(null)
      )
    return () => {
      live = false
    }
  }, [userId, keyChanged, dialogOpen])
  if (keyChanged) return 'changed'
  return trust && trust.userId === userId ? BADGE[trust.state] : null
}

/** A verified contact's key changed: sending is paused until the user decides (E5). */
export function useSendPaused(userIds: readonly string[]): string | null {
  return useCryptoStore(
    (s) =>
      s.keyChanges.find((k) => k.severity === 'blocking' && userIds.includes(k.userId))?.userId ??
      null
  )
}
