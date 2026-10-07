import { useCryptoStore } from '@/stores/cryptoStore'

/** A verified contact's key changed: sending is paused until the user decides (E5). */
export function useSendPaused(userIds: readonly string[]): string | null {
  return useCryptoStore(
    (s) =>
      s.keyChanges.find((k) => k.severity === 'blocking' && userIds.includes(k.userId))?.userId ??
      null
  )
}
