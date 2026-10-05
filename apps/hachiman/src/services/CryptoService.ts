/**
 * Owns the one CryptoClient (the @hachiman/crypto Worker, §12.17) of the signed-in user.
 *
 * - `start` makes the client with the main-thread DsTransport, gets the store wrap key from
 *   IPlatformService.secureStorage and calls init. `stop` disposes the Worker on sign-out. The
 *   Worker store stays on disk for the next sign-in.
 * - Every CryptoEvents event goes into cryptoStore, and to the listeners of `on`.
 * - The UI thread never holds key material. The calls return only status, content and pointers.
 */
import {
  CryptoError,
  createCryptoClient,
  createCryptoStub,
  type CryptoClient,
  type CryptoEvents,
  type CryptoGatewayEvent,
  type CryptoStatus,
  type DeviceProof,
  type DeviceProofInput,
  type DsTransport
} from '@hachiman/crypto'
import { CLIENT_VERSION } from '@/lib/client-version'
import { takusenService } from '@/services/TakusenService'
import type { IPlatformService } from '@/shared/IPlatformService'
import {
  addMembership,
  pushKeyChange,
  resetCryptoStore,
  setCryptoFatal,
  useCryptoStore
} from '@/stores/cryptoStore'

export interface CryptoStartOptions {
  userId: string
  /** The host seam: the wrap key and the platform name. Null only for the stub. */
  platform: IPlatformService | null
  transport: DsTransport
}

type Listener<K extends keyof CryptoEvents> = (payload: CryptoEvents[K]) => void

const EVENTS = [
  'status',
  'keyChange',
  'forkAlert',
  'membership',
  'linkSas',
  'linkDone',
  'epochKeysAvailable',
  'ktAlert',
  'voiceRoster',
  'error'
] as const satisfies readonly (keyof CryptoEvents)[]

function asShape(e: unknown): { code: CryptoError['code']; message: string; dsCode?: string } {
  if (e instanceof CryptoError) return { code: e.code, message: e.message, dsCode: e.dsCode }
  const code = (e as { code?: unknown } | null)?.code
  const message = e instanceof Error ? e.message : String(e)
  if (
    code === 'SecureStorageUnavailable' ||
    code === 'StoreCorrupt' ||
    code === 'Malformed' ||
    code === 'LockHeld'
  )
    return { code, message }
  return { code: 'Internal', message }
}

/** A throwaway wrap key for the stub, which stores nothing. */
const stubWrapKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

class CryptoService {
  private current: CryptoClient | null = null
  private userId: string | null = null
  private platform: IPlatformService | null = null
  private unsubscribe: (() => void)[] = []
  private stub = false
  /** The status that the listeners heard last. */
  private notified: string | null = null
  private readonly listeners = new Map<keyof CryptoEvents, Set<(payload: never) => void>>()

  /** Dev preview only: use the unencrypted stub (dev/preview). */
  useStub(): void {
    this.stub = true
  }

  /** Signed in: make the client and init it. Idempotent for one user; another user stops first. */
  async start(opts: CryptoStartOptions): Promise<void> {
    if (this.current && this.userId === opts.userId && useCryptoStore.getState().phase !== 'error')
      return
    this.stop()
    setCryptoFatal(null)
    this.userId = opts.userId
    this.platform = opts.platform
    useCryptoStore.setState({ phase: 'starting', startError: null })
    const client = this.stub
      ? createCryptoStub()
      : createCryptoClient({ transport: opts.transport })
    this.current = client
    this.unsubscribe = EVENTS.map((event) => this.subscribe(client, event))
    try {
      const platform = opts.platform
      if (!this.stub && !platform)
        throw new CryptoError('SecureStorageUnavailable', 'the host gave no secure storage')
      const wrapKey =
        platform && !this.stub
          ? await platform.secureStorage.getWrapKey(opts.userId)
          : await stubWrapKey()
      const status = await client.init({
        userId: opts.userId,
        wrapKey,
        platform: platform?.platform ?? 'browser',
        clientVersion: CLIENT_VERSION,
        deviceName: platform?.platform === 'electron' ? 'Hachiman Desktop' : 'Hachiman Web',
        origin: new URL(takusenService.env.apiBase).origin
      })
      if (this.current !== client) return
      if (status.state === 'revoked') {
        // The DS removed this device and the user signed in again: start over as a new device.
        // The wipe destroys the store, so the next start is needs_identity (onboarding links or
        // restores). A failed wipe fails the start (the error screen), so this cannot loop.
        await client.signOutDevice()
        if (this.current !== client) return
        this.stop()
        return this.start(opts)
      }
      useCryptoStore.setState({ phase: 'ready' })
      this.setStatus(status)
    } catch (e) {
      if (this.current !== client) return
      console.error('[crypto] start failed', e)
      useCryptoStore.setState({ phase: 'error', startError: asShape(e) })
    }
  }

  /** Signed out: dispose the Worker. The store stays on disk. */
  stop(): void {
    this.unsubscribe.forEach((u) => u())
    this.unsubscribe = []
    this.current?.dispose()
    this.current = null
    this.userId = null
    this.notified = null
    resetCryptoStore()
  }

  /** The client of the signed-in user. Throws CryptoError('NotInitialized') before init finished. */
  client(): CryptoClient {
    if (!this.current || useCryptoStore.getState().phase !== 'ready')
      throw new CryptoError('NotInitialized', 'encryption is not ready on this device')
    return this.current
  }

  /**
   * The device proof of a request (§12.12, §12.13). The Worker signs: the key never leaves it. Works
   * while init runs too (a request of the init itself).
   */
  proveDevice(req: DeviceProofInput): Promise<DeviceProof> {
    if (!this.current) return Promise.reject(new CryptoError('NotInitialized', 'no crypto Worker'))
    return this.current.proveDevice(req)
  }

  /** True when the Worker is up and the identity of this device is set up. */
  get ready(): boolean {
    return (
      this.current !== null &&
      useCryptoStore.getState().phase === 'ready' &&
      useCryptoStore.getState().status?.state === 'ready'
    )
  }

  /** Listens to a Worker event across client restarts. Returns unsubscribe. */
  on<K extends keyof CryptoEvents>(event: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    const f = cb as (payload: never) => void
    set.add(f)
    return () => {
      set.delete(f)
    }
  }

  /**
   * §12.13 events go to the Worker. Dropped while it is not ready: `sync` catches up. Not
   * DEVICE_LINK: it drives the link of a new device (§12.5), which is 'linking', not 'ready',
   * until the link finishes. Dropping it stalled every link before the emoji or the transfer.
   */
  onGatewayEvent(event: CryptoGatewayEvent): void {
    const started = this.current !== null && useCryptoStore.getState().phase === 'ready'
    if (!this.ready && !(event.t === 'DEVICE_LINK' && started)) return
    void this.current
      ?.onGatewayEvent(event)
      .catch((e: unknown) => console.warn('[crypto] %s failed', event.t, e))
  }

  /** READY and RESUMED: groups, key packages, inbox and KT catch up. */
  sync(): void {
    if (!this.ready) return
    void this.current?.sync().catch((e: unknown) => console.warn('[crypto] sync failed', e))
  }

  /** Reads the status again (after a link finished, for example). */
  async refreshStatus(): Promise<CryptoStatus> {
    const status = await this.client().status()
    this.setStatus(status)
    return status
  }

  /**
   * First device of the user. Resolves the one-time recovery key: the caller shows it and keeps
   * it in component state only.
   */
  async setupFirstDevice(): Promise<{ recoveryKey: string }> {
    const { recoveryKey, status } = await this.client().setupFirstDevice()
    this.setStatus(status)
    return { recoveryKey }
  }

  async restoreFromRecoveryKey(recoveryKey: string): Promise<CryptoStatus> {
    const status = await this.client().restoreFromRecoveryKey(recoveryKey)
    this.setStatus(status)
    return status
  }

  /** After a password reset without the recovery key: a new identity. Old history is unreadable. */
  async resetIdentity(): Promise<{ recoveryKey: string }> {
    const { recoveryKey, status } = await this.client().resetIdentity()
    this.setStatus(status)
    return { recoveryKey }
  }

  /**
   * Forget this device: the Worker revokes it (reason signed_out) and deletes its store, the host
   * deletes the wrap key, and the app signs out.
   */
  async signOutDevice(): Promise<void> {
    const userId = this.userId
    const platform = this.platform
    await this.client().signOutDevice()
    if (userId && platform) await platform.secureStorage.clear(userId)
    takusenService.signOut()
  }

  private subscribe<K extends keyof CryptoEvents>(client: CryptoClient, event: K): () => void {
    return client.on(event, (payload) => {
      if (this.current !== client) return
      // init() also gives the status: setStatus tells the listeners of a change once.
      if (event === 'status') return this.setStatus(payload as CryptoStatus)
      this.mirror(event, payload)
      this.notify(event, payload)
    })
  }

  private notify<K extends keyof CryptoEvents>(event: K, payload: CryptoEvents[K]): void {
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        ;(cb as Listener<K>)(payload)
      } catch (e) {
        console.error('[crypto] %s listener failed', event, e)
      }
    }
  }

  /** Stores the status. The listeners hear each change once, after init finished. */
  private setStatus(status: CryptoStatus): void {
    useCryptoStore.setState({ status })
    // A revocation while the app runs: sign out. At start (phase 'starting'), start() wipes the
    // device and starts over instead, so the next sign-in does not end here again.
    if (status.state === 'revoked' && useCryptoStore.getState().phase === 'ready') {
      setCryptoFatal('device_revoked')
      takusenService.signOut()
      return
    }
    if (useCryptoStore.getState().phase !== 'ready') return
    const key = `${status.state}:${status.deviceId ?? ''}`
    if (key === this.notified) return
    this.notified = key
    this.notify('status', status)
  }

  private mirror<K extends keyof CryptoEvents>(event: K, payload: CryptoEvents[K]): void {
    const p = payload as CryptoEvents[keyof CryptoEvents]
    switch (event) {
      case 'status':
        return
      case 'keyChange':
        return pushKeyChange(p as CryptoEvents['keyChange'])
      case 'forkAlert': {
        const alert = p as CryptoEvents['forkAlert']
        return useCryptoStore.setState((s) => ({
          forkAlerts: [...s.forkAlerts.filter((f) => f.groupId !== alert.groupId), alert]
        }))
      }
      case 'membership': {
        const e = p as CryptoEvents['membership']
        if (e.channelId) addMembership(e.channelId, [e])
        return
      }
      case 'linkSas':
        return useCryptoStore.setState({ linkSas: p as CryptoEvents['linkSas'] })
      case 'linkDone':
        return useCryptoStore.setState({ linkDone: p as CryptoEvents['linkDone'] })
      case 'ktAlert':
        return useCryptoStore.setState((s) => ({
          ktAlerts: [...s.ktAlerts, p as CryptoEvents['ktAlert']]
        }))
      case 'voiceRoster': {
        const r = p as CryptoEvents['voiceRoster']
        const voice = useCryptoStore.getState().voice
        if (voice?.handle === r.handle)
          useCryptoStore.setState({ voice: { ...voice, roster: r.roster, epoch: r.epoch } })
        return
      }
      case 'error':
        return useCryptoStore.setState({ lastError: p as CryptoEvents['error'] })
    }
  }
}

export const cryptoService = new CryptoService()
