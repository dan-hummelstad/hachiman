/**
 * DS error helpers that the services share. Not exported from index.ts.
 */
import { CryptoError, type EngineContext } from './api'

/** The REST error code (§4/§12.19) of a failed DS call, or undefined for any other error. */
export function dsCodeOf(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'dsCode' in e && typeof e.dsCode === 'string') return e.dsCode
  return undefined
}

/** A DS or transport failure: the item is retried later, never given a failure code. */
export function isTransient(e: unknown): boolean {
  return dsCodeOf(e) !== undefined || (e instanceof CryptoError && e.code === 'Transport')
}

export function reportError(ctx: Pick<EngineContext, 'emit'>, e: unknown): void {
  ctx.emit('error', { code: e instanceof CryptoError ? e.code : 'Transport', message: e instanceof Error ? e.message : String(e), dsCode: dsCodeOf(e) })
}
