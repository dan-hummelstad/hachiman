/**
 * Standalone gRPC server entry point. Run via `pnpm dev:grpc` (or `pnpm dev`,
 * which starts it next to Next.js) and `pnpm start:grpc` in production.
 *
 * Lives separate from Next.js: Next has no clean "after listen" hook and a
 * colocated gRPC port would flap on every Next dev file-watcher restart.
 *
 * Env vars:
 *   - TAKUSEN_GRPC_PORT       — port number (default 50051).
 *   - TAKUSEN_GRPC_BIND_ADDR  — full host:port override. Unset = loopback only
 *                              (127.0.0.1). Setting it to a non-loopback addr
 *                              opens the unauthenticated RegisterMediaNode /
 *                              PlaceMediaSession surface; the server emits a
 *                              prominent warning at startup. mTLS lands with
 *                              Phase 5 cert provisioning.
 */
import { TakusenGrpcServer } from './server'

async function main() {
  // Honour the explicit bind-addr override; otherwise let TakusenGrpcServer
  // pick the loopback default. We don't synthesise host:port here so the
  // server's default-derivation stays in one place.
  const bindAddr = process.env.TAKUSEN_GRPC_BIND_ADDR?.trim()
  const server = new TakusenGrpcServer(bindAddr ? { bindAddr } : {})
  await server.start()

  const shutdown = async (signal: string) => {
    console.log(`[takusen-grpc] ${signal} received, draining…`)
    await server.stop()
    console.log('[takusen-grpc] shutdown complete')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[takusen-grpc] fatal:', err)
  process.exit(1)
})
