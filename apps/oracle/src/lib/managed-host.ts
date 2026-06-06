/**
 * Pure (DB-free, framework-free) helpers for stamping the host:port that
 * a managed server is advertised on. Split out of `lib/servers.ts` so the
 * unit tests can exercise the env-not-set failure path without booting the
 * postgres-js pool (importing `db/client` throws when `DATABASE_URL` is
 * unset, which would otherwise leak into the test runtime).
 */
import type { z } from 'zod'

import type { createServerSchema } from './server-schemas'

// The zod-parsed payload, WITHOUT the `ownerUserId` field that callers stamp
// in at the API boundary. The resolver only looks at `mode`/`host`/`port`.
type ParsedCreateServer = z.infer<typeof createServerSchema>

/**
 * The Mumble voice port used as the INITIAL placeholder for a managed
 * server's placement row. The real port is allocated by the gateway —
 * Grumble auto-derives `64738 + vServerId - 1` for each in-process vServer
 * — and reported back through the management gRPC `CreateVirtualServer`
 * response. `createServer` overwrites the placement's port with that real
 * value inside the same transaction, so this constant is only ever visible
 * for the brief window between the placement INSERT and the post-gRPC
 * UPDATE. We keep the column NOT NULL with this default to satisfy the
 * schema and to give self-hosted+default-port owners a sane fallback when
 * the `port` field is omitted on the create payload.
 *
 * Eventually a regional L4 ingress / on-host wake proxy may front-door
 * managed Mumble on the protocol's default 64738 regardless of which
 * in-process vServer the request resolves to (see
 * apps/hachiman-server/THIN-RELAY-DESIGN.md) — at that point this constant
 * stops being a placeholder and becomes the canonical advertised port
 * again. Until that infra ships, the per-vServer port IS what we advertise.
 */
export const MANAGED_SERVER_PORT = 64738

/**
 * Name of the env var that names the public-facing host a managed server is
 * advertised on (typically a CNAME pointing at the regional ingress, e.g.
 * `gateway.hachiman.moe`). Exported so error messages and `.env.example` stay
 * in lock-step with the single source of truth.
 */
export const MANAGED_GATEWAY_HOST_ENV = 'TAKUSEN_MANAGED_GATEWAY_HOST'

/**
 * Raised by the managed-server branch of `resolveServerEndpoint` when
 * `TAKUSEN_MANAGED_GATEWAY_HOST` isn't set. We do NOT silently fall back to
 * localhost: a managed server's host is what we hand to clients on the public
 * internet, so a missing env is a configuration error the operator must fix.
 */
export class ManagedGatewayNotConfiguredError extends Error {
  constructor() {
    super(`Managed servers require ${MANAGED_GATEWAY_HOST_ENV} to be set`)
    this.name = 'ManagedGatewayNotConfiguredError'
  }
}

/**
 * Pick the `(host, port)` pair the registry row should persist for a server.
 *
 *  - self-hosted → owner-supplied (the schema already validated `host` via
 *    `hostSchema` and `port` is bounded 1..65535).
 *  - managed     → stamped from `TAKUSEN_MANAGED_GATEWAY_HOST` + the
 *    hardcoded Mumble port. The env is read at CALL TIME (not module load)
 *    so a dev's `.env` change is picked up on the next request without
 *    restarting the process. Any host/port the client tried to send on the
 *    managed branch is dropped — the schema's discriminated union already
 *    strips those fields from the `managed` branch; this is defense-in-depth.
 *
 * Throws `ManagedGatewayNotConfiguredError` when mode === 'managed' and the
 * env is unset / blank. Callers should map that to a 503 at the API layer
 * (see `api-helpers.ts`).
 */
export function resolveServerEndpoint(
  parsed: ParsedCreateServer,
): { host: string; port: number } {
  if (parsed.mode === 'self-hosted') {
    return { host: parsed.host, port: parsed.port ?? MANAGED_SERVER_PORT }
  }
  const managedHost = process.env[MANAGED_GATEWAY_HOST_ENV]?.trim()
  if (!managedHost) {
    throw new ManagedGatewayNotConfiguredError()
  }
  return { host: managedHost, port: MANAGED_SERVER_PORT }
}
