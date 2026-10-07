import type { ContactDevice, SafetyNumber, TrustInfo } from '@hachiman/crypto'
import { useKeyedAsync } from '@/hooks/use-keyed-async'
import { cryptoService } from '@/services/CryptoService'
import { useContactTrust } from './use-contact-trust'

export interface ContactSecurity {
  /** null while it loads, or when the Worker cannot answer (then `error` is set). */
  trust: TrustInfo | null
  safety: SafetyNumber | null
  /** Only devices whose certificate chain the Worker checked (§12.4), oldest first. null: loading. */
  devices: ContactDevice[] | null
  error: string | null
}

interface Loaded {
  safety: SafetyNumber
  devices: ContactDevice[]
}

/**
 * Trust (useContactTrust), safety number and devices of one contact, from the crypto Worker. The
 * safety number and devices read again when the master key or a pending key change (whose
 * candidate key the safety number uses) changes. A user without a key
 * ('unknown') has neither.
 */
export function useContactSecurity(userId: string): ContactSecurity {
  const { trust, error } = useContactTrust(userId)
  const key =
    trust && trust.state !== 'unknown'
      ? `${userId}|${trust.masterKeyGeneration ?? ''}|${trust.state === 'changed'}`
      : null
  const result = useKeyedAsync<Loaded>(key, async () => {
    const client = cryptoService.client()
    const [safety, devices] = await Promise.all([
      client.getSafetyNumber(userId),
      // A device list that fails to load shows no devices; the trust card still shows.
      client.listContactDevices(userId).catch((): ContactDevice[] => [])
    ])
    return { safety, devices: [...devices].sort((a, b) => a.issuedAtMs - b.issuedAtMs) }
  })
  if (error !== null) return { trust: null, safety: null, devices: null, error }
  if (result?.error !== undefined)
    return { trust, safety: null, devices: null, error: result.error }
  return {
    trust,
    safety: result?.data?.safety ?? null,
    devices: trust?.state === 'unknown' ? [] : (result?.data?.devices ?? null),
    error: null
  }
}
