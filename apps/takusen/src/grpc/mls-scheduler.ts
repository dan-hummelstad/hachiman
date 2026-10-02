/**
 * The MLS batch scheduler and the daily DS sweeps (docs/gateway-protocol.md
 * §12.7.5, §12.7.9, §12.15). It runs in the gRPC process because Next.js has
 * no background jobs.
 *
 * - Every TAKUSEN_MLS_BATCH_INTERVAL_MS, and on each `takusen:mls_wakeup`, it
 *   runs one scheduler step for each group with work (lib/mls/batches.ts).
 * - Once a day it deletes handshakes and inbox items older than 30 days,
 *   expired link sessions, join requests older than 7 days, group epochs
 *   beyond the newest 8 and unreferenced page media (lib/page-media-sweep.ts),
 *   and it starts suite upgrades.
 */
import { fromB64, toB64 } from '../lib/mls/bytes'
import { JOIN_REQUEST_RETENTION_MS } from '../lib/mls/config'
import type { DsDeps } from '../lib/mls/context'
import { GROUP_STATE_EPOCHS_KEPT, HANDSHAKE_RETENTION_MS } from '../lib/mls/crypto'
import { flushOutbox, Outbox } from '../lib/mls/events'
import { runSchedulerTick } from '../lib/mls/batches'
import { upgradeSuite } from '../lib/mls/membership'
import type { MlsRepo } from '../lib/mls/repo'
import { sweepPageMedia, type PageMediaSweepRepo } from '../lib/page-media-sweep'

const DAY_MS = 24 * 60 * 60_000

export interface MlsSchedulerOptions {
  repo: MlsRepo
  deps: DsDeps
  /** Subscribes to `takusen:mls_wakeup`. Returns the unsubscribe function. */
  subscribe?: (onGroup: (groupId: string) => void) => Promise<() => Promise<void>>
  /** Publishes an outbox. Default: Redis. */
  flush?: (out: Outbox) => Promise<void>
  logger?: (msg: string) => void
  /** The page media sweep and the object delete. Unset: no page media sweep. */
  pageMedia?: { repo: PageMediaSweepRepo; deleteObjects: (keys: string[]) => Promise<void> }
}

export interface SweepResult {
  handshakes: number
  inbox: number
  linkSessions: number
  joinRequests: number
  epochs: number
  pageMedia: number
  upgrades: number
}

export class MlsScheduler {
  private timer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private unsubscribe: (() => Promise<void>) | null = null
  private running: Promise<void> = Promise.resolve()
  private readonly flush: (out: Outbox) => Promise<void>
  private readonly log: (msg: string) => void

  constructor(private readonly opts: MlsSchedulerOptions) {
    this.flush = opts.flush ?? flushOutbox
    this.log = opts.logger ?? ((m) => console.log(`[mls-scheduler] ${m}`))
  }

  async start(): Promise<void> {
    if (this.opts.subscribe) {
      this.unsubscribe = await this.opts.subscribe((groupId) => {
        if (fromB64(groupId)) void this.tick(new Set([groupId]))
      })
    }
    this.timer = setInterval(() => void this.tick(), this.opts.deps.config.batchIntervalMs)
    this.sweepTimer = setInterval(() => void this.sweep().catch((err) => console.error('[mls-scheduler] sweep failed', err)), DAY_MS)
    void this.sweep().catch((err) => console.error('[mls-scheduler] sweep failed', err))
    this.log(`running every ${this.opts.deps.config.batchIntervalMs} ms`)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.timer = this.sweepTimer = null
    if (this.unsubscribe) await this.unsubscribe()
    await this.running
  }

  /** One scheduler pass. Passes never overlap: a wakeup during a pass waits for it. */
  tick(only?: Set<string>): Promise<void> {
    this.running = this.running.then(async () => {
      const out = new Outbox()
      try {
        await runSchedulerTick(this.opts.repo, this.opts.deps, out, only)
      } catch (err) {
        console.error('[mls-scheduler] tick failed', err)
      }
      await this.flush(out)
    })
    return this.running
  }

  /** The daily sweep (§12.7.9 retention, §12.15 suite upgrades). */
  async sweep(): Promise<SweepResult> {
    const { repo, deps } = this.opts
    const now = deps.now()
    const result: SweepResult = {
      handshakes: await repo.deleteHandshakesBefore(new Date(now.getTime() - HANDSHAKE_RETENTION_MS)),
      inbox: await repo.deleteExpiredInbox(now),
      linkSessions: await repo.deleteExpiredLinkSessions(now),
      joinRequests: await repo.deleteJoinRequestsBefore(new Date(now.getTime() - JOIN_REQUEST_RETENTION_MS)),
      epochs: await repo.pruneAllGroupEpochs(GROUP_STATE_EPOCHS_KEPT),
      pageMedia: this.opts.pageMedia ? await sweepPageMedia(this.opts.pageMedia.repo, now, this.opts.pageMedia.deleteObjects) : 0,
      upgrades: 0,
    }
    if (deps.config.suites.length > 1) {
      for (const g of await repo.listActiveGroups()) {
        const out = new Outbox()
        try {
          const next = await repo.transaction((r) => upgradeSuite(r, deps, out, g))
          if (next) {
            result.upgrades++
            this.log(`suite upgrade of ${toB64(g.groupId)} → generation ${next.generation}`)
          }
        } catch (err) {
          console.error('[mls-scheduler] suite upgrade failed', err)
        }
        await this.flush(out)
      }
    }
    return result
  }
}
