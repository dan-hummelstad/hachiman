/**
 * gRPC client for Grumble's internal management API.
 *
 * The managed-server flow needs Oracle to provision an in-process vServer
 * on the Grumble side at registration time — that's the point of "managed":
 * the user doesn't run their own Mumble server, we boot one for them. This
 * module is the thin TypeScript wrapper around the `GrumbleManagement`
 * service defined in `apps/hachiman-server/pkg/management/management.proto`.
 *
 * Production deploys will replace this single-endpoint hard-wire with the
 * placement-aware scheduler (pick an island from `lib/scheduler.ts`, dial
 * THAT island's gRPC) — see `apps/oracle/src/lib/placement.ts` and the
 * `feat/latency-placement` slice plan in the repo. Today, every managed
 * server lands on the single dev/staging island named by
 * `TAKUSEN_MANAGED_GATEWAY_GRPC`.
 *
 * The proto file is loaded at runtime via `@grpc/proto-loader` rather than
 * via a codegen step so we don't have to keep generated TS in sync; the
 * proto is the source of truth and lives once, in `hachiman-server/`. This
 * costs us static type checking on the wire shape — the wrapper below
 * narrows the dynamic shape into the typed interface the rest of the app
 * sees, so callers still get full type-checking.
 *
 * SECURITY: matches the Go management.proto comment. The gRPC server is
 * loopback-only and unauthenticated; pointing Oracle at a non-loopback
 * gateway over an untrusted network is a misconfiguration. Production-grade
 * auth (mTLS / bearer) is future work on BOTH sides.
 */
import 'server-only'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

/**
 * Name of the env var that names the gRPC endpoint of the managed-gateway
 * Grumble process (e.g. `127.0.0.1:50051` in dev, an internal-VPC address
 * in prod). Exported so error messages and `.env.example` stay aligned with
 * the single source of truth.
 */
export const GRUMBLE_MANAGEMENT_GRPC_ENV = 'TAKUSEN_MANAGED_GATEWAY_GRPC'

/**
 * Path to the `management.proto` source of truth. Resolved relative to THIS
 * file's location in the monorepo so the wrapper works regardless of where
 * `next dev` / `next start` was invoked from. For deploys outside the
 * monorepo, copy or volume-mount the proto file alongside the running
 * Oracle process and update this path.
 */
const PROTO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'hachiman-server',
  'pkg',
  'management',
  'management.proto',
)

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised by `createVirtualServer` when `TAKUSEN_MANAGED_GATEWAY_GRPC` isn't
 * set. The registry can't honour a managed-server request without a place
 * to boot the vServer; api-helpers maps this to 503 with a message naming
 * the env var so the operator can self-serve.
 */
export class GrumbleManagementNotConfiguredError extends Error {
  constructor() {
    super(
      `Managed servers require ${GRUMBLE_MANAGEMENT_GRPC_ENV} to be set (e.g. 127.0.0.1:50051)`,
    )
    this.name = 'GrumbleManagementNotConfiguredError'
  }
}

/**
 * Raised when the gRPC call itself fails — wraps the underlying error so
 * the API layer can distinguish "the gateway is unreachable" (a 502-class
 * problem) from "we never tried" (NotConfigured → 503).
 */
export class GrumbleManagementError extends Error {
  /** gRPC status code on the wire, when one was returned. */
  readonly grpcCode: number | undefined
  constructor(message: string, grpcCode?: number) {
    super(message)
    this.name = 'GrumbleManagementError'
    this.grpcCode = grpcCode
  }
}

// ---------------------------------------------------------------------------
// Typed surface (narrowed from the proto-loader dynamic shape)
// ---------------------------------------------------------------------------

export interface CreateVirtualServerArgs {
  /**
   * The Oracle user id that should be granted SuperUser on the new vServer
   * via the `handleAuthenticate` owner-grant path. Persisted by Grumble in
   * the per-vServer `AdminOracleUserID` config key. Empty string = no
   * Oracle-mapped admin (treated identically to a self-hosted Grumble).
   */
  adminOracleUserId: string
  /**
   * RFC 7662 introspection URL Grumble should use to verify inbound
   * `Authenticate.oracle_token` values. Stamped on the new vServer's
   * `OracleIntrospectionURL` config. Pass an empty string to skip — but
   * note that without all three of URL+id+secret Grumble's
   * introspection check is a silent no-op, so for managed creates you
   * should always pass all three.
   */
  oracleIntrospectionUrl: string
  /**
   * The confidential client_id Grumble presents on the introspection
   * call (client_secret_basic). Must match a registered client on the
   * Oracle side dedicated to managed-gateway introspection. Stamped on
   * `OracleClientID`.
   */
  oracleClientId: string
  /**
   * The client_secret paired with oracleClientId. Sent over the
   * (loopback-only) gRPC channel and stamped on `OracleClientSecret`.
   * NEVER log this value.
   */
  oracleClientSecret: string
}

export interface CreateVirtualServerResult {
  /**
   * Grumble's numeric in-process vServer id (the `Server.Id` in
   * cmd/grumble). The caller persists this so we can later issue
   * DeleteVirtualServer / read per-vServer state without rediscovering
   * the mapping.
   */
  serverId: number
  /**
   * The TCP/UDP port the freshly-booted vServer is listening on. Grumble
   * auto-derives this from the vServer id (default 64738 + id - 1) unless
   * the per-vServer `Port` config key is set; Oracle persists what Grumble
   * reports rather than recomputing the derivation.
   */
  port: number
  /**
   * The WebSocket port the vServer is listening on, or 0 when web
   * listening is disabled for this vServer. Same rationale as `port`.
   */
  webPort: number
}

// ---------------------------------------------------------------------------
// Client cache
// ---------------------------------------------------------------------------

// The proto-loader generated client is `any` at the type layer; we cache
// it across calls so we don't pay re-parse + reconnect cost on every
// managed-server registration. Endpoint changes are rare (env var doesn't
// flip mid-process), but we key the cache on endpoint so a deliberate
// change is picked up without a process restart.
interface CachedClient {
  endpoint: string
  client: {
    createVirtualServer(
      req: {
        adminOracleUserId: string
        oracleIntrospectionUrl: string
        oracleClientId: string
        oracleClientSecret: string
      },
      cb: (
        err: grpc.ServiceError | null,
        response: {
          serverId: number | bigint
          port: number | bigint
          webPort: number | bigint
        },
      ) => void,
    ): void
    deleteVirtualServer(
      req: { serverId: number },
      cb: (err: grpc.ServiceError | null, response: Record<string, never>) => void,
    ): void
  }
  closer: () => void
}
let cached: CachedClient | null = null

function getClient(endpoint: string): CachedClient {
  if (cached && cached.endpoint === endpoint) return cached
  // Tear down any previous client (different endpoint = config change).
  if (cached) cached.closer()

  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false, // proto `admin_oracle_user_id` → JS `adminOracleUserId`
    longs: Number, // server_id is int64; coerce to Number (safe up to 2^53)
    enums: String,
    defaults: true,
    oneofs: true,
  })
  // The generated package is dynamic — narrow it with a localized cast so
  // the rest of the module stays statically typed. The nested path mirrors
  // `package grumble.management.v1;` in management.proto: proto-loader turns
  // each dotted segment into a nested JS object, so a flat `grpcObj.management`
  // lookup returns undefined.
  const grpcObj = grpc.loadPackageDefinition(packageDef) as unknown as {
    grumble: {
      management: {
        v1: {
          GrumbleManagement: new (
            endpoint: string,
            credentials: grpc.ChannelCredentials,
          ) => CachedClient['client'] & { close(): void }
        }
      }
    }
  }

  const client = new grpcObj.grumble.management.v1.GrumbleManagement(
    endpoint,
    grpc.credentials.createInsecure(),
  )
  cached = {
    endpoint,
    client,
    closer: () => client.close(),
  }
  return cached
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ask the managed-gateway Grumble process to create a new in-process
 * vServer with the given owner. Returns Grumble's numeric server id —
 * persist it so we can later DeleteVirtualServer / route control-plane
 * calls without rediscovering the mapping.
 *
 * Throws:
 *   - {@link GrumbleManagementNotConfiguredError} when the env is unset.
 *   - {@link GrumbleManagementError} when the gRPC call fails.
 *
 * Callers in a database transaction can rely on these throws to roll the
 * transaction back (the Oracle `servers` row is created in the same tx as
 * this call; an unconfigured gateway or a Grumble-side failure leaves no
 * orphan row behind).
 */
export async function createVirtualServer(
  args: CreateVirtualServerArgs,
): Promise<CreateVirtualServerResult> {
  const endpoint = process.env[GRUMBLE_MANAGEMENT_GRPC_ENV]?.trim()
  if (!endpoint) {
    throw new GrumbleManagementNotConfiguredError()
  }
  const { client } = getClient(endpoint)
  return new Promise<CreateVirtualServerResult>((resolve, reject) => {
    client.createVirtualServer(
      {
        adminOracleUserId: args.adminOracleUserId,
        oracleIntrospectionUrl: args.oracleIntrospectionUrl,
        oracleClientId: args.oracleClientId,
        oracleClientSecret: args.oracleClientSecret,
      },
      (err, response) => {
        if (err) {
          reject(
            new GrumbleManagementError(
              `Grumble CreateVirtualServer failed: ${err.message}`,
              err.code,
            ),
          )
          return
        }
        resolve({
          serverId: Number(response.serverId),
          port: Number(response.port),
          webPort: Number(response.webPort),
        })
      },
    )
  })
}

export interface DeleteVirtualServerArgs {
  /** Grumble's numeric in-process vServer id (from CreateVirtualServerResult). */
  serverId: number
}

/**
 * Ask the managed-gateway Grumble process to tear down the named in-process
 * vServer (stop listeners + delete the DB row in one go — see the proto
 * comment for the stop-first-then-delete ordering rationale).
 *
 * Idempotency: Grumble returns NotFound (gRPC code 5) when the id is
 * unknown. We accept that as success because the caller's goal — "after
 * this call returns, the vServer no longer exists on the gateway" — is
 * already met; a redundant delete (e.g. retry after a partial failure)
 * mustn't kick over the cleanup loop.
 */
export async function deleteVirtualServer(
  args: DeleteVirtualServerArgs,
): Promise<void> {
  const endpoint = process.env[GRUMBLE_MANAGEMENT_GRPC_ENV]?.trim()
  if (!endpoint) {
    throw new GrumbleManagementNotConfiguredError()
  }
  const { client } = getClient(endpoint)
  await new Promise<void>((resolve, reject) => {
    client.deleteVirtualServer({ serverId: args.serverId }, (err) => {
      if (err) {
        // gRPC NOT_FOUND = 5. Treat as success (see jsdoc above).
        if (err.code === grpc.status.NOT_FOUND) {
          resolve()
          return
        }
        reject(
          new GrumbleManagementError(
            `Grumble DeleteVirtualServer failed for serverId=${args.serverId}: ${err.message}`,
            err.code,
          ),
        )
        return
      }
      resolve()
    })
  })
}
