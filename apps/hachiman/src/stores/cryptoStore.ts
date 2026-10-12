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
  /**
   * Users whose blocking key change the user closed with "not now" (the Close of M58 on the
   * mobile layout). Their dialog does not open again by itself; sending to them stays paused, and
   * a tap on the paused composer opens it. User ids only, never key material.
   */
  deferredKeyChanges: string[]
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
  /**
   * Guilds that the user joined with an invite with history whose history did not open (§12.11.4).
   * Guild ids only: never the key or the invite code.
   */
  inviteHistoryFailures: string[]
}

type CryptoData = Omit<CryptoState, 'fatal'>

const initialCryptoState = (): CryptoData => ({
  phase: 'idle',
  status: null,
  startError: null,
  keyChanges: [],
  deferredKeyChanges: [],
  forkAlerts: [],
  ktAlerts: [],
  membership: new Map(),
  linkSas: null,
  linkDone: null,
  voice: null,
  voiceResyncing: false,
  voiceResyncFailed: false,
  lastError: null,
  inviteHistoryFailures: []
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

/** `ids` without `userId`: the same array when it is not in it, so selectors keep their value. */
const withoutUser = (ids: string[], userId: string): string[] =>
  ids.includes(userId) ? ids.filter((u) => u !== userId) : ids

/**
 * A key change event of the Worker. The Worker can report one pending change again (each chain
 * fetch of a DSK downgrade). A repeat with the same severity keeps the user's "not now"; a new
 * change or a new severity asks again.
 */
export function pushKeyChange(e: CryptoEvents['keyChange']): void {
  useCryptoStore.setState((s) => {
    const repeat = s.keyChanges.some((k) => k.userId === e.userId && k.severity === e.severity)
    return {
      keyChanges: [...s.keyChanges.filter((k) => k.userId !== e.userId), e],
      deferredKeyChanges: repeat
        ? s.deferredKeyChanges
        : withoutUser(s.deferredKeyChanges, e.userId)
    }
  })
}

/** The user accepted the new key or verified the contact: the change and its "not now" go. */
export function dismissKeyChange(userId: string): void {
  useCryptoStore.setState((s) => ({
    keyChanges: s.keyChanges.filter((k) => k.userId !== userId),
    deferredKeyChanges: withoutUser(s.deferredKeyChanges, userId)
  }))
}

/**
 * "Not now" for the blocking key change of `userId` (M58 Close): the dialog does not open again
 * by itself. The change stays pending, so sending stays paused. No-op without a pending change.
 */
export function deferKeyChange(userId: string): void {
  useCryptoStore.setState((s) =>
    s.keyChanges.some((k) => k.userId === userId) && !s.deferredKeyChanges.includes(userId)
      ? { deferredKeyChanges: [...s.deferredKeyChanges, userId] }
      : s
  )
}

export function dismissForkAlert(groupId: string): void {
  useCryptoStore.setState((s) => ({
    forkAlerts: s.forkAlerts.filter((f) => f.groupId !== groupId)
  }))
}

export function dismissKtAlerts(): void {
  useCryptoStore.setState({ ktAlerts: [] })
}

export function pushInviteHistoryFailure(guildId: string): void {
  useCryptoStore.setState((s) => ({
    inviteHistoryFailures: [...s.inviteHistoryFailures.filter((g) => g !== guildId), guildId]
  }))
}

export function dismissInviteHistoryFailure(guildId: string): void {
  useCryptoStore.setState((s) => ({
    inviteHistoryFailures: s.inviteHistoryFailures.filter((g) => g !== guildId)
  }))
}

export function clearLinkState(): void {
  useCryptoStore.setState({ linkSas: null, linkDone: null })
}

/** `inviteKeyId`: two invites with history in one epoch have no subjects, so the key id tells them apart. */
const eventKey = (e: MembershipEvent): string =>
  `${e.groupId}:${e.epoch}:${e.kind}:${e.subjects.map((s) => s.deviceId).join(',')}:${e.inviteKeyId ?? ''}`

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
