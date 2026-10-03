/**
 * Test doubles for the bridge and Worker specs: a Worker over an in-process MessageChannel, an
 * in-memory Web Locks shim, and a wrap key. Not part of the package exports.
 */
import type { CryptoClient, CryptoStore, DsTransport } from '../api'
import type { Engine } from '../worker/engine'
import { serveCryptoWorker } from '../worker/serve'
import { createCryptoClient } from './index'

/** A Worker whose other end is a MessagePort in this thread. */
export function portWorker(port: MessagePort): Worker {
  const fake = {
    postMessage: (m: unknown, transfer: Transferable[] = []) => {
      port.postMessage(m, transfer)
    },
    addEventListener: (type: string, l: (ev: MessageEvent) => void) => {
      if (type === 'message') port.addEventListener('message', l)
    },
    removeEventListener: (type: string, l: (ev: MessageEvent) => void) => {
      if (type === 'message') port.removeEventListener('message', l)
    },
    start: () => {
      port.start()
    },
    terminate: () => {
      port.close()
    },
  }
  return fake as unknown as Worker
}

export interface InProcess {
  client: CryptoClient
  engine: Engine
  /** The Worker-side port (closed with the client). */
  workerPort: MessagePort
}

/** createCryptoClient with the engine served on the other end of a MessageChannel. */
export function inProcessClient(transport: DsTransport, opts: { store?: CryptoStore } = {}): InProcess {
  const { port1, port2 } = new MessageChannel()
  const engine = serveCryptoWorker(port1, opts)
  const client = createCryptoClient({ transport, worker: portWorker(port2) })
  const dispose = client.dispose.bind(client)
  client.dispose = () => {
    dispose()
    port1.close()
  }
  return { client, engine, workerPort: port1 }
}

/** navigator.locks with exclusive locks only, enough for `request(name, { ifAvailable }, cb)`. */
export class LocksShim {
  readonly held = new Set<string>()
  request(name: string, options: { ifAvailable?: boolean }, cb: (lock: { name: string } | null) => Promise<unknown>): Promise<unknown> {
    if (this.held.has(name)) {
      if (options.ifAvailable === true) return Promise.resolve(cb(null))
      return Promise.reject(new Error('the shim supports only ifAvailable'))
    }
    this.held.add(name)
    return Promise.resolve(cb({ name })).finally(() => this.held.delete(name))
  }
}

export function wrapKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
