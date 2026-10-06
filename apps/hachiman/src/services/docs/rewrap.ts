/**
 * The re-wrap pass of a pages channel (contract §4 Pages, §12.20 "Access by new members"). A user
 * that joins the MLS group of a pages channel has no secret of the older epochs. The pass encrypts
 * the newest snapshot pointer and the title of each page again in the current epoch, so the new
 * member opens every page without a member that has it open. The snapshot blob has its own file
 * key, so a pointer re-wrap writes no blob.
 *
 * - Trigger: the Worker event `usersAdded`. The committer runs the pass at once and again after
 *   the epoch grace of §12.8.4, because a member can still post in the old epoch for that time.
 *   Every other member runs it after a random 12 to 20 s. Each pass skips the pages that are
 *   current, and Takusen takes one re-wrap per page and epoch (409 for the others).
 * - A page with updates after a stale snapshot (or with no snapshot) gets a full snapshot (a
 *   provider that shows nothing). An update of the old epoch follows a current snapshot only inside
 *   the epoch grace, so only the committer's second pass loads those pages too.
 * - An open page catches up through its provider (DocProvider.maybeSnapshot).
 *
 * Plain dependencies, so the pass is testable without a Worker, a server or a gateway.
 */
import {
  Permissions,
  RestError,
  has,
  type Channel,
  type DocSnapshot,
  type Page,
  type PageHead,
  type RestClient
} from '@hachiman/client'
import {
  ADD_ONLY_EPOCH_GRACE_MS,
  type CryptoApi,
  type CryptoEvents,
  type DocSnapshotPointer
} from '@hachiman/crypto'
import type { DocProvider } from './types'

/** The committer runs the pass again after this: the last envelope of the old epoch is in then. */
export const REWRAP_AGAIN_MS = ADD_ONLY_EPOCH_GRACE_MS + 2000
/** The random wait of a member that did not commit: after the epoch grace. */
export const REWRAP_DELAY_MS = [12_000, 20_000] as const

type GroupEpoch = { groupId: string; epoch: number }
type DocCrypto = Pick<CryptoApi, 'encryptDoc' | 'decryptDoc'>

const fromUtf8 = new TextDecoder('utf-8', { fatal: true })
/** The error code of a RestError or of a Worker error. */
const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code
const statusOf = (e: unknown): number | null => (e instanceof RestError ? e.status : null)

/** An envelope of another group, or of an older epoch, is closed to a member that joined later. */
export const isStale = (g: GroupEpoch, current: GroupEpoch): boolean =>
  g.groupId !== current.groupId || g.epoch < current.epoch

export function parsePointer(bytes: Uint8Array): DocSnapshotPointer | null {
  try {
    const p = JSON.parse(fromUtf8.decode(bytes)) as Partial<DocSnapshotPointer> | null
    return p &&
      typeof p.uploadId === 'string' &&
      typeof p.fileKey === 'string' &&
      typeof p.sha256 === 'string' &&
      typeof p.size === 'number'
      ? (p as DocSnapshotPointer)
      : null
  } catch {
    return null
  }
}

/**
 * Posts the pointer of `snap` again, encrypted in the current epoch, with the same baseSeq and
 * uploadId. The re-wrapper signs the pointer as its own, so only a pointer that verifies and names
 * the upload of the row goes out. Resolves the new row, or null when this device cannot open the
 * pointer or another member was first (409 SnapshotConflict).
 */
export async function rewrapPointer(
  crypto: DocCrypto,
  rest: Pick<RestClient, 'postPageSnapshot'>,
  channelId: string,
  snap: DocSnapshot
): Promise<DocSnapshot | null> {
  const { pageId } = snap
  const [r] = await crypto.decryptDoc([
    {
      id: 'snapshot',
      channelId,
      pageId,
      kind: 'doc_snapshot',
      senderDevice: snap.senderDevice,
      envelope: snap.envelope
    }
  ])
  if (r?.status !== 'ok' || parsePointer(r.bytes)?.uploadId !== snap.uploadId) return null
  const out = await crypto.encryptDoc({ channelId, pageId, kind: 'doc_snapshot', bytes: r.bytes })
  try {
    return await rest.postPageSnapshot(pageId, {
      baseSeq: snap.baseSeq,
      uploadId: snap.uploadId,
      envelope: out.envelope,
      mediaUploadIds: snap.mediaUploadIds
    })
  } catch (e) {
    if (codeOf(e) === 'SnapshotConflict') return null
    throw e
  }
}

/**
 * PATCHes the title of `page` again, encrypted in the current epoch. The bytes stay as they are.
 * `ifUpdatedAt` keeps a rename that came in between: 409 PageConflict skips the page.
 */
async function rewrapTitle(
  crypto: DocCrypto,
  rest: Pick<RestClient, 'updatePage'>,
  page: Page
): Promise<void> {
  const [r] = await crypto.decryptDoc([
    {
      id: page.id,
      channelId: page.channelId,
      pageId: page.id,
      kind: 'doc_title',
      senderDevice: null,
      envelope: page.titleEnvelope
    }
  ])
  if (r?.status !== 'ok') return
  const out = await crypto.encryptDoc({
    channelId: page.channelId,
    pageId: page.id,
    kind: 'doc_title',
    bytes: r.bytes
  })
  try {
    await rest.updatePage(page.id, { titleEnvelope: out.envelope, ifUpdatedAt: page.updatedAt })
  } catch (e) {
    if (codeOf(e) !== 'PageConflict') throw e
  }
}

/** The pages channels of the group in which this user can view and write: the channels of a pass. */
export function pagesChannelsOf(
  channels: Iterable<Pick<Channel, 'id' | 'type' | 'mlsGroupId'>>,
  groupId: string,
  permissionsFor: (channelId: string) => number
): string[] {
  const need = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES
  return [...channels]
    .filter(
      (c) => c.type === 'pages' && c.mlsGroupId === groupId && has(permissionsFor(c.id), need)
    )
    .map((c) => c.id)
}

/**
 * Snapshots a page that is not open with a headless provider, and always destroys the provider.
 * `running` holds the provider meanwhile, so that a sign-out destroys it (DocsService.reset).
 */
export async function snapshotHeadless(
  provider: Pick<DocProvider, 'snapshotIfNeeded' | 'destroy'>,
  running: Set<Pick<DocProvider, 'destroy'>>
): Promise<void> {
  running.add(provider)
  try {
    await provider.snapshotIfNeeded()
  } finally {
    running.delete(provider)
    provider.destroy()
  }
}

export interface RewrapDeps {
  rest: Pick<RestClient, 'getPageHeads' | 'getPages' | 'postPageSnapshot' | 'updatePage'>
  /** The crypto Worker. Throws while it is not ready. */
  crypto(): Pick<CryptoApi, 'encryptDoc' | 'decryptDoc' | 'ensureChannelGroup'>
  /** The pages channels of the group in which this user can view and write. */
  channelsOf(groupId: string): string[]
  /** Resyncs the provider of an open page, which re-wraps or snapshots it. False when it is not open. */
  resyncOpen(pageId: string): boolean
  /** Loads the page without showing it, and posts a snapshot when the snapshot rules call for one. */
  snapshotPage(channelId: string, pageId: string): Promise<void>
  random?(): number
}

/**
 * One pass over one channel: snapshots and pointers first, then the titles. `thorough`: the
 * committer's second pass, which also loads the pages with updates after a current snapshot.
 * `cancelled`: true after a sign-out. The pass stops before its next page and before the titles.
 */
export async function rewrapChannel(
  deps: RewrapDeps,
  channelId: string,
  thorough = false,
  cancelled: () => boolean = () => false
): Promise<void> {
  const crypto = deps.crypto()
  const group = await crypto.ensureChannelGroup(channelId)
  if (group.epoch === null) return
  const cur = { groupId: group.groupId, epoch: group.epoch }
  const staleTitle = (h: PageHead): boolean => h.title !== null && isStale(h.title, cur)
  const heads = await deps.rest.getPageHeads(channelId)
  // A 403 (the channel is read-only for me now) stops the channel; another failure, the page.
  const each = async (pageId: string, task: () => Promise<unknown>): Promise<void> => {
    try {
      await task()
    } catch (e) {
      if (statusOf(e) === 403) throw e
      console.warn('[docs] re-wrap of page %s failed', pageId, codeOf(e) ?? e)
    }
  }
  for (const head of heads) {
    if (cancelled()) return
    if (deps.resyncOpen(head.pageId)) continue
    const snap = head.snapshot
    const staleSnap = snap !== null && isStale(snap, cur)
    if (head.latestSeq > (snap?.baseSeq ?? 0)) {
      if (snap === null || staleSnap || thorough)
        await each(head.pageId, () => deps.snapshotPage(channelId, head.pageId))
    } else if (snap && staleSnap)
      await each(head.pageId, () => rewrapPointer(crypto, deps.rest, channelId, snap))
  }
  if (cancelled() || !heads.some(staleTitle)) return
  // The page list first, then the heads again: a rename after the list read fails the
  // compare-and-set, and a rename before the second heads read makes the title current.
  const pages = await deps.rest.getPages(channelId)
  const stale = new Set(
    (await deps.rest.getPageHeads(channelId)).filter(staleTitle).map((h) => h.pageId)
  )
  for (const page of pages) {
    if (!stale.has(page.id)) continue
    if (cancelled()) return
    await each(page.id, () => rewrapTitle(crypto, deps.rest, page))
  }
}

export interface Rewrapper {
  onUsersAdded(e: CryptoEvents['usersAdded']): void
  /** Sign-out: no pass starts after this, and a pass that runs stops before its next page. */
  reset(): void
}

/** The timing of the passes, one at a time per group (a request during a pass runs one more). */
export function createRewrapper(deps: RewrapDeps): Rewrapper {
  const random = deps.random ?? Math.random
  const timers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; due: number; then: number | null }
  >()
  /**
   * groupId → the generation of its running pass. A pass of an older generation (before a reset)
   * stops at its next page and does not hold back a pass of the new one.
   */
  const running = new Map<string, number>()
  /** A request during a pass gives one more pass, for the latest time asked. */
  const rerun = new Map<string, number>()
  /** The due time of the committer's second pass: the first pass for that time is thorough. */
  const thoroughAt = new Map<string, number>()
  let generation = 0

  /** `at`: the time for which the pass was asked (now, or the due time of its timer). */
  function pass(groupId: string, at: number): void {
    if (running.get(groupId) === generation) {
      rerun.set(groupId, Math.max(rerun.get(groupId) ?? at, at))
      return
    }
    const due = thoroughAt.get(groupId)
    const thorough = due !== undefined && at >= due
    if (thorough) thoroughAt.delete(groupId)
    const gen = generation
    const cancelled = (): boolean => gen !== generation
    running.set(groupId, gen)
    void (async () => {
      for (const channelId of deps.channelsOf(groupId)) {
        if (cancelled()) return
        await rewrapChannel(deps, channelId, thorough, cancelled).catch((e: unknown) =>
          console.warn('[docs] re-wrap of channel %s failed', channelId, codeOf(e) ?? e)
        )
      }
    })().finally(() => {
      // A pass of the new generation runs: its own end handles the requests.
      if (running.get(groupId) !== gen) return
      running.delete(groupId)
      const again = rerun.get(groupId)
      rerun.delete(groupId)
      if (again !== undefined) pass(groupId, again)
    })
  }

  /** A pass at `due` or later. An earlier timer stays: the later pass follows it. */
  function schedule(groupId: string, due: number): void {
    const cur = timers.get(groupId)
    if (cur) {
      if (due > cur.due) cur.then = Math.max(cur.then ?? 0, due)
      return
    }
    const entry = {
      due,
      then: null as number | null,
      timer: setTimeout(
        () => {
          timers.delete(groupId)
          pass(groupId, due)
          if (entry.then !== null) schedule(groupId, entry.then)
        },
        Math.max(0, due - Date.now())
      )
    }
    timers.set(groupId, entry)
  }

  return {
    onUsersAdded(e) {
      const now = Date.now()
      if (e.byMe) {
        const again = now + REWRAP_AGAIN_MS
        thoroughAt.set(e.groupId, Math.max(thoroughAt.get(e.groupId) ?? again, again))
        pass(e.groupId, now)
        schedule(e.groupId, again)
        return
      }
      const [min, max] = REWRAP_DELAY_MS
      schedule(e.groupId, now + min + random() * (max - min))
    },
    reset() {
      generation++
      for (const t of timers.values()) clearTimeout(t.timer)
      timers.clear()
      rerun.clear()
      thoroughAt.clear()
    }
  }
}
