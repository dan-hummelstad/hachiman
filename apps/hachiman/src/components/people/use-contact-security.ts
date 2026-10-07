import type { ContactDevice, SafetyNumber, TrustInfo } from '@hachiman/crypto'
import { useKeyedAsync } from '@/hooks/use-keyed-async'
import { cryptoService } from '@/services/CryptoService'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useDialogStore } from '@/stores/dialogStore'

export interface ContactSecurity {
  /** null while it loads, or when the Worker cannot answer (then `error` is set). */
  trust: TrustInfo | null
  safety: SafetyNumber | null
  /** Only devices whose certificate chain the Worker checked (§12.4), oldest first. null: loading. */
  devices: ContactDevice[] | null
  error: string | null
}

interface Loaded {
  trust: TrustInfo
  safety: SafetyNumber
  devices: ContactDevice[]
}

/** The look of each trust state: gold "Not verified", green "Verified", coral "Key changed". */
export const TRUST_LOOK: Record<
  TrustInfo['state'],
  { label: string; text: string; card: string; chip: string }
> = {
  verified: {
    label: 'Verified',
    text: 'text-feature-voice-text',
    card: 'border-feature-voice/40 bg-feature-voice/10',
    chip: 'bg-feature-voice/15 text-feature-voice-text'
  },
  tofu: {
    label: 'Not verified',
    text: 'text-feature-event-text',
    card: 'border-feature-event/40 bg-feature-event/10',
    chip: 'bg-feature-event/15 text-feature-event-text'
  },
  changed: {
    label: 'Key changed',
    text: 'text-feature-danger-text',
    card: 'border-feature-danger/50 bg-feature-danger/10',
    chip: 'bg-feature-danger/15 text-feature-danger-text'
  },
  unknown: {
    label: 'No key yet',
    text: 'text-text-tertiary',
    card: 'border-line-hairline',
    chip: 'bg-surface-raised text-text-tertiary'
  }
}

/**
 * Trust, safety number and devices of one contact, from the crypto Worker. Read again when the
 * Worker becomes ready, when the verification dialog closes and when a key change arrives.
 */
export function useContactSecurity(userId: string): ContactSecurity {
  const ready = useCryptoStore((s) => s.phase === 'ready')
  const dialogOpen = useDialogStore((s) => s.dialog?.kind === 'verification')
  const keyChange = useCryptoStore((s) => s.keyChanges.some((k) => k.userId === userId))
  const key = ready && !dialogOpen ? `${userId}|${keyChange ? 'changed' : 'same'}` : null
  const result = useKeyedAsync<Loaded>(key, async () => {
    const client = cryptoService.client()
    const [trust, safety, devices] = await Promise.all([
      client.getTrust(userId),
      client.getSafetyNumber(userId),
      // A device list that fails to load shows no devices; the trust card still shows.
      client.listContactDevices(userId).catch((): ContactDevice[] => [])
    ])
    return { trust, safety, devices: [...devices].sort((a, b) => a.issuedAtMs - b.issuedAtMs) }
  })
  if (!ready) return { trust: null, safety: null, devices: null, error: 'not ready' }
  if (result?.error !== undefined)
    return { trust: null, safety: null, devices: null, error: result.error }
  return {
    trust: result?.data?.trust ?? null,
    safety: result?.data?.safety ?? null,
    devices: result?.data?.devices ?? null,
    error: null
  }
}
