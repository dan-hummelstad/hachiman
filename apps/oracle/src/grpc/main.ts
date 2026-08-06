/**
 * Standalone gRPC server entry point. Run via `pnpm dev:oracle-grpc` (script
 * added to apps/oracle/package.json) or via the equivalent production runner.
 *
 * Lives separate from Next.js per Phase 3a spec section D: Next has no clean
 * "after listen" hook and a colocated gRPC port would flap on every Next dev
 * file-watcher restart.
 *
 * Env vars:
 *   - ORACLE_GRPC_PORT       — port number (default 50051).
 *   - ORACLE_GRPC_BIND_ADDR  — full host:port override. Unset = loopback only
 *                              (127.0.0.1). Setting it to a non-loopback addr
 *                              opens the unauthenticated RegisterMediaNode /
 *                              PlaceMediaSession surface; the server emits a
 *                              prominent warning at startup. mTLS lands with
 *                              Phase 5 cert provisioning.
 */
import { OracleGrpcServer } from './server'

async function main() {
  // Honour the explicit bind-addr override; otherwise let OracleGrpcServer
  // pick the loopback default. We don't synthesise host:port here so the
  // server's default-derivation stays in one place.
  const bindAddr = process.env.ORACLE_GRPC_BIND_ADDR?.trim()
  const server = new OracleGrpcServer(bindAddr ? { bindAddr } : {})
  await server.start()

  const shutdown = async (signal: string) => {
    console.log(`[oracle-grpc] ${signal} received, draining…`)
    await server.stop()
    console.log('[oracle-grpc] shutdown complete')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[oracle-grpc] fatal:', err)
  process.exit(1)
})
