/**
 * The in-process engine, for a host process that is itself the key holder: a bot (`@hachiman/bot`)
 * runs in Node with no UI thread and no Worker. The browser hosts never import this entry: their
 * UI thread talks to the Worker through `createCryptoClient` (`.`), so key material stays in the
 * Worker (§12.17).
 */
export { createEngine, type Engine, type EngineEnv } from './worker/engine'
export { clientPermissions } from './worker/permissions'
export { serializeValue, deserializeValue } from './store/serialize'
