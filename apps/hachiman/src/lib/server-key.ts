/**
 * Stable-identity derivation for a row in the local `serverStore`.
 *
 * Two regimes:
 *   - Oracle-registered (managed) servers: identity = Takusen `serverId`
 *     (server-side UUID). Multiple managed vServers can share one gateway
 *     host (the host front-doors a whole island), so keying on host alone
 *     would let only the first one in.
 *   - Self-hosted servers: identity = composite `${host}:${port}`. The user
 *     can run multiple dev servers on `localhost:64739` / `:64740` / …, but
 *     a duplicate `(host, port)` is still rejected.
 *
 * Use this as the SINGLE source of truth for the store key — never compute
 * `host` / `serverId` independently in callers.
 */
export interface ServerKeyInput {
  /** Takusen UUID (Oracle-registered). Present → key on this. */
  serverId?: string | null
  /** Network host (e.g. "localhost", "gateway.example.com"). Required. */
  host: string
  /** Network port. Used when falling back to the self-hosted composite. */
  port: number
}

export function deriveServerId(input: ServerKeyInput): string {
  if (input.serverId) return input.serverId
  return `${input.host}:${input.port}`
}

/**
 * Convenience: a one-line dedupe predicate for "is this address already in
 * the store under some OTHER id?". Used to reject self-hosted re-adds even
 * when the would-be id differs (shouldn't happen with deriveServerId, but
 * the check is cheap and forward-compatible).
 */
export function sameAddress(
  a: { host: string; port: number },
  b: { host: string; port: number }
): boolean {
  return a.host === b.host && a.port === b.port
}
