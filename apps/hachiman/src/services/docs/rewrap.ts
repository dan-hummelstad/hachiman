/**
 * The re-wrap pass of a pages channel (contract §4 Pages, §12.20 "Access by new members"). A user
 * that joins the MLS group of a pages channel has no secret of the older epochs. The pass encrypts
 * the newest snapshot pointer, the title and the banner of each page again in the current epoch,
 * so the new member opens every page without a member that has it open. The snapshot and banner
 * blobs have their own file keys, so a re-wrap writes no blob.
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
  type Page,
  type PageHead,
  type RestClient,
  type UpdatePageBody
} from '@hachiman/client'
import {
  ADD_ONLY_EPOCH_GRACE_MS,
  type CryptoApi,
  type CryptoEvents,
  type DocEnvelopeKindName,
  type EncryptedDocItem
} from '@hachiman/crypto'
import { isStale, rewrapPointer } from './envelopes'
import type { DocProvider } from './types'

/** The committer runs the pass again after this: the last envelope of the old epoch is in then. */
export const REWRAP_AGAIN_MS = ADD_ONLY_EPOCH_GRACE_MS + 2000
/** The random wait of a member that did not commit: after the epoch grace. */
export const REWRAP_DELAY_MS = [12_000, 20_000] as const

type DocCrypto = Pick<CryptoApi, 'encryptDoc' | 'decryptDoc'>

/** The error code of a RestError or of a Worker error. */
const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code
const statusOf = (e: unknown): number | null => (e instanceof RestError ? e.status : null)

/**
 * Encrypts the row envelope `envelope` of `page` again in the current epoch, with the same bytes.
 * Null when it does not open here: only a decrypted envelope is re-wrapped.
 */
async function rewrapEnvelope(
  crypto: DocCrypto,
  page: Page,
  kind: Extract<DocEnvelopeKindName, 'doc_title' | 'doc_banner'>,
  envelope: string
): Promise<string | null> {
  const item: EncryptedDocItem = {
    id: page.id,
    channelId: page.channelId,
    pageId: page.id,
    kind,
    senderDevice: null,
    envelope
  }
  const [r] = await crypto.decryptDoc([item])
  if (r?.status !== 'ok') return null
  const out = await crypto.encryptDoc({
    channelId: page.channelId,
    pageId: page.id,
    kind,
    bytes: r.bytes
  })
  return out.envelope
}

/**
 * PATCHes the stale row envelopes of `page` (its title, its banner or both) again, encrypted in
 * the current epoch, in one PATCH. The bytes stay as they are: the banner pointer is not parsed.
 * The banner goes without `uploadIds`, so Takusen keeps the stored ids and claims nothing (the
 * re-wrapper is usually not the uploader). `ifUpdatedAt` keeps a rename or a banner change that
 * came in between: 409 PageConflict skips the page.
 */
async function rewrapRow(
  crypto: DocCrypto,
  rest: Pick<RestClient, 'updatePage'>,
  page: Page,
  stale: { title: boolean; banner: boolean }
): Promise<void> {
  const body: UpdatePageBody = {}
  if (stale.title) {
    const envelope = await rewrapEnvelope(crypto, page, 'doc_title', page.titleEnvelope)
    if (envelope !== null) body.titleEnvelope = envelope
  }
  if (stale.banner && page.bannerEnvelope !== null) {
    const envelope = await rewrapEnvelope(crypto, page, 'doc_banner', page.bannerEnvelope)
    if (envelope !== null) body.banner = { envelope }
  }
  if (body.titleEnvelope === undefined && body.banner === undefined) return
  try {
    await rest.updatePage(page.id, { ...body, ifUpdatedAt: page.updatedAt })
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
 * One pass over one channel: snapshots and pointers first, then the titles and banners.
 * `thorough`: the committer's second pass, which also loads the pages with updates after a current
 * snapshot. `cancelled`: true after a sign-out. The pass stops before its next page and before the
 * titles and banners.
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
  const staleBanner = (h: PageHead): boolean => h.banner !== null && isStale(h.banner, cur)
  const staleRow = (h: PageHead): boolean => staleTitle(h) || staleBanner(h)
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
  if (cancelled() || !heads.some(staleRow)) return
  // The page list first, then the heads again: a rename or banner change after the list read
  // fails the compare-and-set, and one before the second heads read makes the envelope current.
  const pages = await deps.rest.getPages(channelId)
  const stale = new Map(
    (await deps.rest.getPageHeads(channelId))
      .filter(staleRow)
      .map((h) => [h.pageId, { title: staleTitle(h), banner: staleBanner(h) }])
  )
  for (const page of pages) {
    const which = stale.get(page.id)
    if (!which) continue
    if (cancelled()) return
    await each(page.id, () => rewrapRow(crypto, deps.rest, page, which))
  }
}

export interface Rewrapper {
  onUsersAdded(e: CryptoEvents['usersAdded']): void
  /** Sign-out: no pass starts after this, and a pass that runs stops before its next page. */
  reset(): void
}

/**
 * The pass state of one group. A reset drops every record: a pass from before it changes only
 * its own record.
 */
interface GroupPass {
  timer: { handle: ReturnType<typeof setTimeout>; due: number; then: number | null } | null
  running: boolean
  /** A request during a pass gives one more pass, for the latest time asked. */
  rerunAt: number | null
  /** The due time of the committer's second pass: the first pass for that time is thorough. */
  thoroughAt: number | null
  /** Set by reset: the pass stops before its next page, and its end starts no other pass. */
  cancelled: boolean
}

/** The timing of the passes, one at a time per group (a request during a pass runs one more). */
export function createRewrapper(deps: RewrapDeps): Rewrapper {
  const random = deps.random ?? Math.random
  const groups = new Map<string, GroupPass>()
  const groupOf = (groupId: string): GroupPass => {
    let g = groups.get(groupId)
    if (!g) {
      g = { timer: null, running: false, rerunAt: null, thoroughAt: null, cancelled: false }
      groups.set(groupId, g)
    }
    return g
  }

  /** `at`: the time for which the pass was asked (now, or the due time of its timer). */
  function pass(groupId: string, at: number): void {
    const g = groupOf(groupId)
    if (g.running) {
      g.rerunAt = Math.max(g.rerunAt ?? at, at)
      return
    }
    const thorough = g.thoroughAt !== null && at >= g.thoroughAt
    if (thorough) g.thoroughAt = null
    g.running = true
    const cancelled = (): boolean => g.cancelled
    void (async () => {
      for (const channelId of deps.channelsOf(groupId)) {
        if (cancelled()) return
        await rewrapChannel(deps, channelId, thorough, cancelled).catch((e: unknown) =>
          console.warn('[docs] re-wrap of channel %s failed', channelId, codeOf(e) ?? e)
        )
      }
    })().finally(() => {
      g.running = false
      const again = g.rerunAt
      g.rerunAt = null
      if (!g.cancelled && again !== null) pass(groupId, again)
    })
  }

  /** A pass at `due` or later. An earlier timer stays: the later pass follows it. */
  function schedule(groupId: string, due: number): void {
    const g = groupOf(groupId)
    if (g.timer) {
      if (due > g.timer.due) g.timer.then = Math.max(g.timer.then ?? 0, due)
      return
    }
    const t = {
      due,
      then: null as number | null,
      handle: setTimeout(
        () => {
          g.timer = null
          pass(groupId, due)
          if (t.then !== null) schedule(groupId, t.then)
        },
        Math.max(0, due - Date.now())
      )
    }
    g.timer = t
  }

  return {
    onUsersAdded(e) {
      const now = Date.now()
      if (e.byMe) {
        const g = groupOf(e.groupId)
        const again = now + REWRAP_AGAIN_MS
        g.thoroughAt = Math.max(g.thoroughAt ?? again, again)
        pass(e.groupId, now)
        schedule(e.groupId, again)
        return
      }
      const [min, max] = REWRAP_DELAY_MS
      schedule(e.groupId, now + min + random() * (max - min))
    },
    reset() {
      for (const g of groups.values()) {
        g.cancelled = true
        if (g.timer) clearTimeout(g.timer.handle)
      }
      groups.clear()
    }
  }
}
