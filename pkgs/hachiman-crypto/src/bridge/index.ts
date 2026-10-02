/**
 * The UI-thread side of the crypto Worker (docs/gateway-protocol.md §12.17).
 *
 * createCryptoClient proxies CryptoApi to the Worker, serves the Worker's DsTransport calls with
 * the given transport, and delivers CryptoEvents to on() listeners. init() first takes the Web Lock
 * `hachiman-crypto:{origin}:{userId}`: two Workers on one store would fork the group state, so a
 * second tab gets CryptoError('Unsupported') with a message that says so.
 *
 * This file imports no engine module. The Worker code loads only inside the Worker.
 */
import { CryptoError, type CreateCryptoClient, type CryptoApi, type CryptoClient, type CryptoEvents, type InitOptions } from '../api'
import { createRpcPeer, CRYPTO_API_METHODS, CRYPTO_EVENTS, DS_TRANSPORT_METHODS, type RpcHandler } from '../worker/rpc'

/** The UI shows "open in another tab" for this message prefix. */
export const LOCK_HELD_MESSAGE = 'hachiman-crypto is open in another tab'

export function cryptoLockName(origin: string, userId: string): string {
  return `hachiman-crypto:${origin}:${userId}`
}

interface HeldLock {
  name: string
  release: () => void
}

/** Takes `name` if it is free (ifAvailable) and holds it until release(). */
function acquireLock(name: string): Promise<HeldLock> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks
  if (locks === undefined) return Promise.reject(new CryptoError('Unsupported', 'this browser has no Web Locks API: the crypto store cannot be guarded'))
  return new Promise<HeldLock>((resolve, reject) => {
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    locks
      .request(name, { ifAvailable: true }, async (lock) => {
        if (lock === null) {
          reject(new CryptoError('Unsupported', `${LOCK_HELD_MESSAGE} (${name})`))
          return
        }
        resolve({ name, release })
        await held
      })
      .catch((e: unknown) => {
        reject(new CryptoError('Unsupported', `Web Lock ${name}: ${e instanceof Error ? e.message : String(e)}`))
      })
  })
}

export const createCryptoClient: CreateCryptoClient = (opts) => {
  const worker = opts.worker ?? new Worker(new URL('../worker/main.ts', import.meta.url), { type: 'module' })
  const transport = opts.transport
  const listeners = new Map<keyof CryptoEvents, Set<(payload: never) => void>>()
  const knownEvents = new Set<string>(CRYPTO_EVENTS)
  let lock: HeldLock | null = null
  let locking: Promise<HeldLock> | null = null
  let disposed = false

  function deliver(event: string, payload: unknown): void {
    if (!knownEvents.has(event)) return
    for (const cb of listeners.get(event as keyof CryptoEvents) ?? []) {
      try {
        ;(cb as (p: unknown) => void)(payload)
      } catch (e) {
        // A listener bug must not stop the other listeners.
        console.error('crypto event listener failed', e)
      }
    }
  }

  const peer = createRpcPeer(worker, {
    serve: () => transport as unknown as Record<string, RpcHandler>,
    allow: DS_TRANSPORT_METHODS,
    fallbackCode: 'Transport',
    onEvent: deliver,
  })

  worker.addEventListener('error', (ev: Event) => {
    const message = typeof ErrorEvent !== 'undefined' && ev instanceof ErrorEvent ? ev.message : 'the crypto Worker failed'
    const err = new CryptoError('Unsupported', `crypto Worker: ${message}`)
    deliver('error', { code: err.code, message: err.message })
    peer.close(err)
  })

  async function lockFor(o: InitOptions): Promise<void> {
    const name = cryptoLockName(o.origin, o.userId)
    if (lock !== null) {
      if (lock.name !== name) throw new CryptoError('Unsupported', 'this crypto client already serves another user: dispose it first')
      return
    }
    locking ??= acquireLock(name)
    try {
      const held = await locking
      if (disposed) {
        held.release()
        throw new CryptoError('NotInitialized', 'the crypto client is disposed')
      }
      if (held.name !== name) throw new CryptoError('Unsupported', 'this crypto client already serves another user: dispose it first')
      lock = held
    } finally {
      locking = null
    }
  }

  const api = Object.fromEntries(CRYPTO_API_METHODS.map((m) => [m, (...args: unknown[]) => peer.call(m, args)])) as unknown as CryptoApi

  const client: CryptoClient = {
    ...api,
    async init(o) {
      if (disposed) throw new CryptoError('NotInitialized', 'the crypto client is disposed')
      await lockFor(o)
      return api.init(o)
    },
    on(event, cb) {
      let set = listeners.get(event)
      if (set === undefined) listeners.set(event, (set = new Set()))
      const f = cb as (payload: never) => void
      set.add(f)
      return () => {
        set.delete(f)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      peer.close(new CryptoError('NotInitialized', 'the crypto client is disposed'))
      worker.terminate()
      lock?.release()
      lock = null
      listeners.clear()
    },
  }
  return client
}

/**
 * One transform Worker for RTCRtpScriptTransform (§12.10.2). Make one per call and keep it for the
 * whole call: setMicrophone and setScreen reuse its transforms, so (key, CTR) never repeats.
 */
export function createTransformWorker(): Worker {
  return new Worker(new URL('../media/transform-worker.ts', import.meta.url), { type: 'module' })
}

export { createCryptoStub } from './stub'
