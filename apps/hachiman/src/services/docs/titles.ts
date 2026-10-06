/**
 * The page titles in docsStore (contract §12.20): the node of a page from the decrypt result of
 * its title, the merge of a new node into the stored one, and the titles that wait for keys
 * (createPageTitles): their retry and the catch-up of a channel whose titles are of an epoch that
 * the Worker does not have yet.
 *
 * Plain dependencies, so the rules are testable without a Worker or a store.
 */
import type { Page } from '@hachiman/client'
import type { CryptoApi, DocDecryptResult } from '@hachiman/crypto'
import type { PageNode } from '@/stores/docsStore'

const fromUtf8 = new TextDecoder('utf-8', { fatal: true })

/** A page without its envelope: the store never holds ciphertext. */
export const nodeOf = (p: Page, title: string, titleState: PageNode['titleState']): PageNode => ({
  id: p.id,
  channelId: p.channelId,
  parentId: p.parentId,
  position: p.position,
  createdBy: p.createdBy,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  title,
  titleState
})

/** The node of a page from the decrypt result of its title. No result: pending. */
export function titleNode(p: Page, r: DocDecryptResult | undefined): PageNode {
  if (r?.status === 'ok') {
    try {
      return nodeOf(p, fromUtf8.decode(r.bytes), 'ok')
    } catch {
      return nodeOf(p, '', 'failed')
    }
  }
  return nodeOf(p, '', r?.status === 'failed' ? 'failed' : 'pending')
}

/**
 * A title that this device decrypted stays while a newer envelope of the page waits for its key
 * (a title re-wrap or a rename in an epoch that the Worker did not apply yet). The other fields
 * come from `next`.
 */
export function keepTitle(stored: PageNode | undefined, next: PageNode): PageNode {
  return stored?.id === next.id && stored.titleState === 'ok' && next.titleState === 'pending'
    ? { ...next, title: stored.title, titleState: 'ok' }
    : next
}

/** The same row as the store has: a title re-wrap changes only the envelope and updatedAt. */
export const sameNode = (a: PageNode | undefined, b: PageNode): boolean =>
  a !== undefined &&
  a.id === b.id &&
  a.titleState === 'ok' &&
  b.titleState === 'ok' &&
  a.title === b.title &&
  a.channelId === b.channelId &&
  a.parentId === b.parentId &&
  a.position === b.position

/** `a` is a newer row of the page than `b`. Takusen sends ISO timestamps, which compare as strings. */
export const isNewer = (
  a: Pick<Page, 'updatedAt'> | undefined,
  b: Pick<Page, 'updatedAt'>
): boolean => a !== undefined && a.updatedAt > b.updatedAt

/**
 * The node to store for `next` (a PAGE_* event, a REST row or a title retry), or null when the
 * store has it or a newer row of the page (a retry that a newer PAGE_UPDATE overtook).
 */
export function mergeNode(stored: PageNode | undefined, next: PageNode): PageNode | null {
  if (isNewer(stored, next)) return null
  const node = keepTitle(stored, next)
  return sameNode(stored, node) ? null : node
}

export interface PageTitlesDeps {
  /** The crypto Worker. Throws while it is not ready. */
  crypto(): Pick<CryptoApi, 'decryptDoc' | 'ensureChannelGroup'>
  findPage(pageId: string): PageNode | undefined
  upsertPage(node: PageNode): void
}

export interface PageTitles {
  /**
   * The nodes of `pages` from their titles. A title that waits for keys stays for retry(). A
   * failure of the Worker call itself (not ready yet): the titles show pending.
   */
  decrypt(pages: Page[]): Promise<PageNode[]>
  /**
   * Stores `node` unless the store has it or a newer row. A decrypted title stays while a newer one
   * is pending.
   */
  store(node: PageNode): void
  /** Decrypts the pending titles again and stores the ones that are no longer pending. */
  retry(): void
  /** The pages are gone: their titles wait no more. */
  forget(pageIds: Iterable<string>): void
  /** The channel is gone: the titles of its pages wait no more. */
  forgetChannel(channelId: string): void
  /** READY, RESUMED: a channel with a title that is ahead gets a catch-up again. */
  onReady(): void
  /** Sign-out: no retry and no store after this. */
  reset(): void
}

/**
 * The titles that wait for keys, with the newest row of each page. They decrypt again on
 * epochKeysAvailable, after a catch-up, and when this device joins a group (retry()).
 *
 * A title is ahead when a member committed and this device did not apply the commit yet: the
 * PAGE_UPDATE of a title re-wrap or rename came before the handshake, or READY decrypts the titles
 * before the Worker syncs. The Worker does not keep doc envelopes for later, so no
 * epochKeysAvailable follows. Thus one catch-up per channel (ensureChannelGroup), then the titles
 * decrypt again. A channel that is still ahead after its catch-up waits for epochKeysAvailable,
 * READY or RESUMED, and for a decrypt of its titles with none ahead: no loop.
 */
export function createPageTitles(deps: PageTitlesDeps): PageTitles {
  /** Pages whose title waits for keys, with the newest row of each. */
  const pending = new Map<string, Page>()
  /** The channels with a catch-up since their titles last decrypted with none ahead. */
  const tried = new Set<string>()
  let generation = 0

  function catchUp(channelId: string): void {
    tried.add(channelId)
    const gen = generation
    void Promise.resolve()
      .then(() => deps.crypto().ensureChannelGroup(channelId))
      .then(
        () => {
          if (gen === generation) retry()
        },
        (e: unknown) => {
          // No retry follows a failure, so the next title that is ahead tries again.
          if (gen === generation) tried.delete(channelId)
          console.warn('[docs] catch-up of channel %s failed', channelId, e)
        }
      )
  }

  /**
   * The titles of `channelIds` were decrypted. `ahead` holds the channels with a title of an epoch
   * after the current one of the Worker (pending 'epoch_ahead').
   */
  function noteResults(channelIds: Iterable<string>, ahead: ReadonlySet<string>): void {
    for (const channelId of new Set(channelIds)) {
      if (!ahead.has(channelId)) tried.delete(channelId)
      else if (!tried.has(channelId)) catchUp(channelId)
    }
  }

  async function decryptTitles(pages: Page[]): Promise<PageNode[]> {
    if (pages.length === 0) return []
    const gen = generation
    const results = await deps.crypto().decryptDoc(
      pages.map((p) => ({
        id: p.id,
        channelId: p.channelId,
        pageId: p.id,
        kind: 'doc_title' as const,
        senderDevice: null,
        envelope: p.titleEnvelope
      }))
    )
    const nodes = pages.map((p, i) => titleNode(p, results[i]))
    if (gen !== generation) return nodes
    const ahead = new Set<string>()
    for (const [i, p] of pages.entries()) {
      const r = results[i]
      if (r?.status === 'pending' && r.reason === 'epoch_ahead') ahead.add(p.channelId)
      // A newer row of the page came in during the decrypt: the entry is the newer row's.
      if (isNewer(pending.get(p.id), p) || isNewer(deps.findPage(p.id), p)) continue
      if (r && r.status !== 'pending') pending.delete(p.id)
      else pending.set(p.id, p)
    }
    noteResults(
      pages.map((p) => p.channelId),
      ahead
    )
    return nodes
  }

  async function decrypt(pages: Page[]): Promise<PageNode[]> {
    try {
      return await decryptTitles(pages)
    } catch (e) {
      console.warn('[docs] titles not decrypted', e)
      for (const p of pages) pending.set(p.id, p)
      return pages.map((p) => nodeOf(p, '', 'pending'))
    }
  }

  function store(node: PageNode): void {
    const merged = mergeNode(deps.findPage(node.id), node)
    if (merged) deps.upsertPage(merged)
  }

  function retry(): void {
    if (pending.size === 0) return
    const gen = generation
    void decrypt([...pending.values()]).then((nodes) => {
      if (gen !== generation) return
      for (const n of nodes) if (n.titleState !== 'pending') store(n)
    })
  }

  return {
    decrypt,
    store,
    retry,
    forget(pageIds) {
      for (const id of pageIds) pending.delete(id)
    },
    forgetChannel(channelId) {
      for (const [id, p] of pending) if (p.channelId === channelId) pending.delete(id)
    },
    onReady() {
      tried.clear()
    },
    reset() {
      generation++
      tried.clear()
      pending.clear()
    }
  }
}
