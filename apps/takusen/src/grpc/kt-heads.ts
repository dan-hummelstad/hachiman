/**
 * The KT tree-head timer (docs/gateway-protocol.md §12.14). Only this process
 * signs heads. Every 10 s, when entries exist past the newest head, it signs
 * a head that covers all of them, stores it, and publishes KT_TREE_HEAD to the
 * owner of each new entry.
 */
import type { DsModule } from '../lib/mls/crypto'
import { flushOutbox, Outbox } from '../lib/mls/events'
import { signNextHead } from '../lib/mls/kt'
import type { KtHeadRow, MlsRepo } from '../lib/mls/repo'

export const KT_HEAD_INTERVAL_MS = 10_000

export interface KtHeadSignerOptions {
  repo: MlsRepo
  ds: Pick<DsModule, 'kt'>
  /** The KT signing seed (TAKUSEN_KT_SIGNING_KEY). */
  seed: Uint8Array
  intervalMs?: number
  now?: () => Date
  flush?: (out: Outbox) => Promise<void>
}

export class KtHeadSigner {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: KtHeadSignerOptions) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? KT_HEAD_INTERVAL_MS)
    void this.tick()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.running
  }

  /** Signs and publishes one head when there are new entries. Steps never overlap. */
  tick(): Promise<KtHeadRow | null> {
    const step = this.running.then(async () => {
      const out = new Outbox()
      try {
        const head = await signNextHead(this.opts.repo, this.opts.ds, this.opts.seed, (this.opts.now ?? (() => new Date()))(), out)
        await (this.opts.flush ?? flushOutbox)(out)
        return head
      } catch (err) {
        console.error('[kt-heads] signing failed', err)
        return null
      }
    })
    this.running = step
    return step
  }
}
