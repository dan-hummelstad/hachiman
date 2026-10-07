import { useEffect, useMemo, useState } from 'react'
import type { VoiceRosterEntry } from '@hachiman/crypto'
import { callParticipants, type CallParticipant } from '@/components/voice/call-roster'
import { useChannelOccupants } from '@/hooks/use-hachiman'
import { cryptoService } from '@/services/CryptoService'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useVoiceStore } from '@/stores/voiceStore'

const EMPTY_ROSTER: VoiceRosterEntry[] = []

/**
 * The E2EE state of the own call. There is no plaintext state: media without keys is dropped.
 * - 'update_required': media or the gateway closed 4012 (§8, §12.13).
 * - 'resyncing': media closed 4013 and VoiceService joins again (new leaf, new transforms).
 * - 'resync_failed': the rejoins after 4013 used every attempt. The client is not in the call.
 * - 'securing': in the call, the voice group has no active epoch yet.
 * - 'secure': the epoch of `epoch` is active.
 * - 'none': not in a call.
 */
export type CallSecurityKind =
  'update_required' | 'resyncing' | 'resync_failed' | 'securing' | 'secure' | 'none'

export function useCallSecurity(): { kind: CallSecurityKind; epoch: number | null } {
  const fatal = useCryptoStore((s) => s.fatal)
  const resyncing = useCryptoStore((s) => s.voiceResyncing)
  const resyncFailed = useCryptoStore((s) => s.voiceResyncFailed)
  const epoch = useCryptoStore((s) => s.voice?.epoch ?? null)
  const inCall = useVoiceStore((s) => s.channelId !== null)
  if (fatal === 'update_required') return { kind: 'update_required', epoch: null }
  if (resyncing) return { kind: 'resyncing', epoch: null }
  if (!inCall) return { kind: resyncFailed ? 'resync_failed' : 'none', epoch: null }
  return epoch === null ? { kind: 'securing', epoch } : { kind: 'secure', epoch }
}

/**
 * The participants of the own call in `channelId`, from the MLS tree (§12.10.1). Null when this
 * client is not in that call: then only the gateway voice states are known, and no tree.
 */
export function useCallParticipants(guildId: string, channelId: string): CallParticipant[] | null {
  const here = useVoiceStore((s) => s.channelId === channelId)
  const occupants = useChannelOccupants(guildId, channelId)
  const peers = useVoiceStore((s) => s.peers)
  const roster = useCryptoStore((s) => s.voice?.roster ?? EMPTY_ROSTER)
  return useMemo(
    () => (here ? callParticipants(occupants, peers, roster) : null),
    [here, occupants, peers, roster]
  )
}

/**
 * The 30-digit epoch code of the active epoch (§12.5), read again from the Worker on each epoch
 * and each new call. Null while the code of the current epoch is not known.
 */
export function useEpochCode(): string | null {
  const handle = useCryptoStore((s) => s.voice?.handle ?? null)
  const epoch = useCryptoStore((s) => s.voice?.epoch ?? null)
  const key = handle !== null && epoch !== null ? `${handle}:${epoch}` : null
  const [result, setResult] = useState<{ key: string; code: string | null } | null>(null)

  useEffect(() => {
    if (key === null || handle === null) return
    let live = true
    const read = async (): Promise<string | null> => cryptoService.client().voiceEpochCode(handle)
    read().then(
      (code) => live && setResult({ key, code }),
      (e: unknown) => {
        console.warn('[voice] epoch code unavailable', e)
        if (live) setResult({ key, code: null })
      }
    )
    return () => {
      live = false
    }
  }, [key, handle])

  // A result of an earlier epoch is never shown as the current code.
  return result !== null && result.key === key ? result.code : null
}
