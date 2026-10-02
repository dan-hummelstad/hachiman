/**
 * Standalone gRPC server entry point. Run via `pnpm dev:grpc` (or `pnpm dev`,
 * which starts it next to Next.js) and `pnpm start:grpc` in production.
 *
 * Lives separate from Next.js: Next has no clean "after listen" hook and a
 * colocated gRPC port would flap on every Next dev file-watcher restart.
 *
 * The same process runs the background jobs of the delivery service
 * (docs/gateway-protocol.md §12.18): the MLS batch scheduler with its daily
 * sweeps (mls-scheduler.ts) and the KT tree-head timer (kt-heads.ts). Only
 * this process signs tree heads.
 *
 * Env vars:
 *   - TAKUSEN_GRPC_PORT       — port number (default 50051).
 *   - TAKUSEN_GRPC_BIND_ADDR  — full host:port override. Unset = loopback only
 *                              (127.0.0.1). Setting it to a non-loopback addr
 *                              opens the unauthenticated RegisterMediaNode /
 *                              PlaceMediaSession surface; the server emits a
 *                              prominent warning at startup. mTLS lands with
 *                              Phase 5 cert provisioning.
 *   - REDIS_URL               — the scheduler wakeup channel and the event bus.
 *   - TAKUSEN_DS_SIGNING_KEY, TAKUSEN_KT_SIGNING_KEY, TAKUSEN_MLS_* — §12.18.
 */
import { dsDeps } from '../lib/mls/context'
import { MLS_WAKEUP_CHANNEL } from '../lib/mls/events'
import { loadOrCreateSeed } from '../lib/mls/keys'
import { drizzleMlsRepo } from '../lib/mls/repo.drizzle'
import { redis } from '../lib/events'
import { drizzlePageMediaSweepRepo } from '../lib/page-media-sweep'
import { deleteObjects } from '../lib/storage'
import { KtHeadSigner } from './kt-heads'
import { MlsScheduler } from './mls-scheduler'
import { TakusenGrpcServer } from './server'

async function startDsJobs(): Promise<() => Promise<void>> {
  const repo = drizzleMlsRepo()
  const deps = await dsDeps()
  const scheduler = new MlsScheduler({
    repo,
    deps,
    pageMedia: { repo: drizzlePageMediaSweepRepo(), deleteObjects },
    async subscribe(onGroup) {
      const sub = redis().duplicate()
      sub.on('message', (_channel: string, message: string) => {
        try {
          const { groupId } = JSON.parse(message) as { groupId?: unknown }
          if (typeof groupId === 'string') onGroup(groupId)
        } catch {
          // A malformed wakeup is dropped. The interval tick still runs.
        }
      })
      await sub.subscribe(MLS_WAKEUP_CHANNEL)
      return async () => {
        await sub.quit()
      }
    },
  })
  const kt = new KtHeadSigner({ repo, ds: deps.ds, seed: loadOrCreateSeed(deps.config.ktKeyPath) })
  await scheduler.start()
  kt.start()
  return async () => {
    await scheduler.stop()
    await kt.stop()
  }
}

async function main() {
  // Honour the explicit bind-addr override; otherwise let TakusenGrpcServer
  // pick the loopback default. We don't synthesise host:port here so the
  // server's default-derivation stays in one place.
  const bindAddr = process.env.TAKUSEN_GRPC_BIND_ADDR?.trim()
  const server = new TakusenGrpcServer(bindAddr ? { bindAddr } : {})
  await server.start()
  const stopDsJobs = await startDsJobs()

  const shutdown = async (signal: string) => {
    console.log(`[takusen-grpc] ${signal} received, draining…`)
    await stopDsJobs()
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
