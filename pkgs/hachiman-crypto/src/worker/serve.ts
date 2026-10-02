/**
 * Serves the engine on one RPC endpoint: the Worker global scope in production (main.ts), a
 * MessagePort in tests. DsTransport calls go back to the UI thread over the same endpoint.
 */
import type { CryptoEvents, CryptoStore, DsTransport } from '../api'
import { createEngine, type Engine } from './engine'
import { clientPermissions } from './permissions'
import { createRpcPeer, CRYPTO_API_METHODS, DS_TRANSPORT_METHODS, type RpcEndpoint, type RpcHandler } from './rpc'

export interface ServeOptions {
  /** Default: the IndexedDB store. */
  store?: CryptoStore
}

export function serveCryptoWorker(endpoint: RpcEndpoint, opts: ServeOptions = {}): Engine {
  let handlers: Record<string, RpcHandler> | null = null
  const peer = createRpcPeer(endpoint, {
    serve: () => handlers,
    allow: CRYPTO_API_METHODS,
    // An exception without a CryptoErrorCode is a bug or a broken input, never a success.
    fallbackCode: 'Malformed',
  })
  const transport = Object.fromEntries(DS_TRANSPORT_METHODS.map((m) => [m, (...args: unknown[]) => peer.call(m, args)])) as unknown as DsTransport
  const engine = createEngine({
    transport,
    emit: <K extends keyof CryptoEvents>(event: K, payload: CryptoEvents[K]) => {
      peer.emit(event, payload)
    },
    adminPermissions: clientPermissions,
    ...(opts.store !== undefined ? { store: opts.store } : {}),
  })
  handlers = engine.api
  return engine
}
