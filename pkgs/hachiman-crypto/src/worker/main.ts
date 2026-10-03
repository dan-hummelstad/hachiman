/**
 * The crypto Worker entry (docs/gateway-protocol.md §12.17). The bridge starts it with
 * new Worker(new URL('../worker/main.ts', import.meta.url), { type: 'module' }).
 */
import type { RpcEndpoint } from './rpc'
import { serveCryptoWorker } from './serve'

serveCryptoWorker(globalThis as unknown as RpcEndpoint)
