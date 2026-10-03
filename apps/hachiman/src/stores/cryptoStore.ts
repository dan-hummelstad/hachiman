import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type {
  CryptoErrorShape,
  CryptoEvents,
  CryptoStatus,
  MembershipEvent,
  VoiceRosterEntry
} from '@hachiman/crypto'

/**
 * The gateway or media closed for good (§12.13):
 * - 'update_required': close 4012. This client is too old or has no `e2ee/1`.
 * - 'device_revoked': close 4013. The device is unknown or revoked. The app signs out.
 */
export type CryptoFatal = 'update_required' | 'device_revoked'

/** Where the crypto Worker is in its start-up for the signed-in user. */
export type CryptoPhase = 'idle' | 'starting' | 'ready' | 'error'

export interface VoiceCryptoState {
  /** The CryptoApi voice handle of the current call. */
  handle: string
  /** The epoch of the voice group, null until the first roster from the MLS tree. */
  epoch: number | null
  /** Participants from the MLS tree (§12.10.1), not from the server roster. */
  roster: VoiceRosterEntry[]
}

/**
 * Mirror of the crypto Worker state for the UI. It holds no key material: only status, alerts and
 * metadata. The Worker keeps every key (§12.17). A recovery key never goes in here: the dialog
 * that asked for it keeps it in component state.
 */
interface CryptoState {
  phase: CryptoPhase
  status: CryptoStatus | null
  /** Why the Worker could not start (for example SecureStorageUnavailable, or another tab holds the lock). */
  startError: CryptoErrorShape | null
  /** Kept through the sign-out that 4013 starts, so the UI can show why. Cleared on the next sign-in. */
  fatal: CryptoFatal | null
  /** Unacknowledged master key changes, oldest first. One entry per user. */
  keyChanges: CryptoEvents['keyChange'][]
  forkAlerts: CryptoEvents['forkAlert'][]
  ktAlerts: CryptoEvents['ktAlert'][]
  /** channelId → membership events in arrival order (the loaded timeline plus live events). */
  membership: Map<string, MembershipEvent[]>
  /** Existing device, SAS mode: the emoji to compare. */
  linkSas: CryptoEvents['linkSas'] | null
  linkDone: CryptoEvents['linkDone'] | null
  voice: VoiceCryptoState | null
  /** Set while VoiceService rejoins after media close 4013 (E2EE resync). */
  voiceResyncing: boolean
  /** The automatic rejoins after 4013 used every attempt. Cleared by the next join or leave. */
  voiceResyncFailed: boolean
  /** The last error event of the Worker. */
  lastError: CryptoErrorShape | null
}

type CryptoData = Omit<CryptoState, 'fatal'>

const initialCryptoState = (): CryptoData => ({
  phase: 'idle',
  status: null,
  startError: null,
  keyChanges: [],
  forkAlerts: [],
  ktAlerts: [],
  membership: new Map(),
  linkSas: null,
  linkDone: null,
  voice: null,
  voiceResyncing: false,
  voiceResyncFailed: false,
  lastError: null
})

export const useCryptoStore = create<CryptoState>()(
  devtools(() => ({ ...initialCryptoState(), fatal: null }))
)

/** Sign-out: drops everything except `fatal`. */
export function resetCryptoStore(): void {
  useCryptoStore.setState(initialCryptoState())
}

export function setCryptoFatal(fatal: CryptoFatal | null): void {
  useCryptoStore.setState({ fatal })
}

/** The device id that IDENTIFY and X-Hachiman-Device send. Null before the device row exists. */
export function currentDeviceId(): string | null {
  const status = useCryptoStore.getState().status
  return status && status.state !== 'revoked' ? status.deviceId : null
}

export function pushKeyChange(e: CryptoEvents['keyChange']): void {
  useCryptoStore.setState((s) => ({
    keyChanges: [...s.keyChanges.filter((k) => k.userId !== e.userId), e]
  }))
}

export function dismissKeyChange(userId: string): void {
  useCryptoStore.setState((s) => ({ keyChanges: s.keyChanges.filter((k) => k.userId !== userId) }))
}

export function dismissForkAlert(groupId: string): void {
  useCryptoStore.setState((s) => ({
    forkAlerts: s.forkAlerts.filter((f) => f.groupId !== groupId)
  }))
}

export function dismissKtAlerts(): void {
  useCryptoStore.setState({ ktAlerts: [] })
}

export function clearLinkState(): void {
  useCryptoStore.setState({ linkSas: null, linkDone: null })
}

const eventKey = (e: MembershipEvent): string =>
  `${e.groupId}:${e.epoch}:${e.kind}:${e.subjects.map((s) => s.deviceId).join(',')}`

/** Adds membership events of one channel in arrival order, without duplicates. */
export function addMembership(channelId: string, events: MembershipEvent[]): void {
  if (events.length === 0) return
  useCryptoStore.setState((s) => {
    const seen = new Set<string>()
    const merged: MembershipEvent[] = []
    for (const e of [...(s.membership.get(channelId) ?? []), ...events]) {
      const k = eventKey(e)
      if (seen.has(k)) continue
      seen.add(k)
      merged.push(e)
    }
    return { membership: new Map(s.membership).set(channelId, merged) }
  })
}
