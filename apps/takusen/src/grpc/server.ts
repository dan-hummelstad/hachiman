/**
 * gRPC server bootstrap. Loads `management.proto` via @grpc/proto-loader,
 * registers the media-plane RPC handlers, and binds 127.0.0.1:50051 by
 * default (configurable via env TAKUSEN_GRPC_PORT for the port half and
 * TAKUSEN_GRPC_BIND_ADDR for the full host:port override).
 *
 * Security posture:
 *   - The gRPC surface implements RegisterMediaNode / MediaNodeHeartbeat /
 *     PlaceMediaSession — anyone who can reach the port can inject fake
 *     nodes, drain real ones, or skew placement. Application-layer auth is
 *     intentionally a follow-up: it lands with mTLS in Phase 5 cert
 *     provisioning (paired with the Go-side follow-up #10 in
 *     pkg/takusenclient/client.go).
 *   - Until mTLS is in place, this server defaults to LOOPBACK ONLY. Operators
 *     who need an external bind (e.g. media / gateway on a different host)
 *     must set TAKUSEN_GRPC_BIND_ADDR explicitly AND own the network
 *     isolation (VPC, security group, private network) — the startup log
 *     emits a prominent warning so the operator is reminded.
 *
 * Decision: Next.js doesn't have a natural "after listen" hook, so this lives
 * behind a standalone `src/grpc/main.ts` entry point invoked via
 * `pnpm dev:grpc` / `pnpm start:grpc`. Sharing a process with
 * Next.js would also bind the gRPC port inside the Next dev server's
 * file-watcher subprocess, which restarts on every file edit — gRPC
 * connections would flap. The separate process pattern is documented in
 * CLAUDE.md so future Claude sessions don't reinvent it.
 */
import * as grpc from '@grpc/grpc-js'

import { mediaNodeHeartbeat, registerMediaNode } from './media-nodes'
import { placeMediaSession } from './placement'
import { loadManagementService, type ManagementHandlers } from './proto'

export interface TakusenGrpcServerOptions {
  /** Bind address. Defaults to "127.0.0.1:<port>" using TAKUSEN_GRPC_PORT or
   *  50051. To bind to a non-loopback address, set the env var
   *  TAKUSEN_GRPC_BIND_ADDR (the bootstrapper in main.ts feeds it here) — see
   *  the file header for the security implications.
   *  Tests pass "127.0.0.1:0" to let the kernel pick a free port. */
  bindAddr?: string
  /** Listener factory — defaults to grpc.ServerCredentials.createInsecure().
   *  mTLS lands with Phase 5 cert provisioning (follow-up #10 on the Go side). */
  credentialsFactory?: () => grpc.ServerCredentials
  /** Logger — defaults to console.log. Useful so tests can capture without
   *  polluting stdout. */
  logger?: (msg: string) => void
}

/** Returns true when host is "127.0.0.1", "localhost", "::1" or "[::1]". The
 *  startup warning fires for anything else, including "0.0.0.0" (the most
 *  dangerous default — wildcard bind opens the unauthenticated surface to
 *  any reachable network). */
function isLoopbackBind(addr: string): boolean {
  // Strip optional port. IPv6 forms come bracketed: "[::1]:50051".
  const lastColon = addr.lastIndexOf(':')
  const host = lastColon === -1 ? addr : addr.slice(0, lastColon)
  if (host === '127.0.0.1' || host === 'localhost') return true
  if (host === '::1' || host === '[::1]') return true
  return false
}

/**
 * TakusenGrpcServer wraps a single grpc.Server and the wiring between the
 * proto descriptor and the handlers. Use `start()` to bind and `stop()` to
 * gracefully drain. Concurrent start/stop is not supported (boot + signal
 * unwinding own the lifecycle).
 */
export class TakusenGrpcServer {
  private readonly server: grpc.Server
  private readonly bindAddr: string
  private readonly credentialsFactory: () => grpc.ServerCredentials
  private readonly logger: (msg: string) => void
  private boundPort: number | null = null

  constructor(opts: TakusenGrpcServerOptions = {}) {
    this.server = new grpc.Server()
    const port = Number(process.env.TAKUSEN_GRPC_PORT ?? '50051')
    // Loopback default — see file header for security rationale. Operators
    // who need an external bind override via TAKUSEN_GRPC_BIND_ADDR (handled
    // upstream in main.ts; here we accept whatever the caller passes).
    this.bindAddr = opts.bindAddr ?? `127.0.0.1:${port}`
    this.credentialsFactory =
      opts.credentialsFactory ?? (() => grpc.ServerCredentials.createInsecure())
    this.logger = opts.logger ?? ((msg) => console.log(msg))

    const service = loadManagementService()
    const handlers: Partial<ManagementHandlers> = {
      RegisterMediaNode: (call, cb) => {
        void registerMediaNode(call, cb)
      },
      MediaNodeHeartbeat: (call, cb) => {
        void mediaNodeHeartbeat(call, cb)
      },
      PlaceMediaSession: (call, cb) => {
        void placeMediaSession(call, cb)
      },
    }
    // grpc-js requires a handler for every RPC in the service definition;
    // stub anything the proto adds before Takusen implements it.
    for (const rpcName of Object.keys(service)) {
      if (rpcName in handlers) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(handlers as any)[rpcName] = (_call: unknown, cb: grpc.sendUnaryData<unknown>) => {
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            message: `${rpcName} is not implemented on Takusen`,
          },
          null,
        )
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.server.addService(service, handlers as any)
  }

  /** Bind and start serving. Resolves once the port is bound. */
  async start(): Promise<number> {
    // Emit a loud warning when binding non-loopback without auth so the
    // operator can't miss the security implication in a busy boot log.
    // mTLS lands in Phase 5; until then, network isolation (VPC / SG /
    // private subnet) is the only thing standing between the open
    // RegisterMediaNode / PlaceMediaSession surface and the public internet.
    if (!isLoopbackBind(this.bindAddr)) {
      this.logger(
        `[takusen-grpc] WARNING: bound to non-loopback ${this.bindAddr} without application-layer auth — restrict via VPC / SG until mTLS lands in Phase 5 (see takusenclient/client.go and management.proto)`,
      )
    }
    return new Promise((resolve, reject) => {
      this.server.bindAsync(this.bindAddr, this.credentialsFactory(), (err, port) => {
        if (err) {
          reject(err)
          return
        }
        this.boundPort = port
        this.logger(`[takusen-grpc] listening on ${this.bindAddr} (port ${port})`)
        resolve(port)
      })
    })
  }

  /** Graceful shutdown — stops accepting new RPCs and waits for in-flight to
   *  drain. Resolves once the server has stopped. */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.tryShutdown((err) => {
        if (err) {
          this.logger(`[takusen-grpc] tryShutdown error (forcing): ${err.message}`)
          this.server.forceShutdown()
        }
        resolve()
      })
    })
  }

  /** Port the server bound to. null before start(). Useful for tests that
   *  bind to :0 and need to read back the assigned port. */
  port(): number | null {
    return this.boundPort
  }
}
