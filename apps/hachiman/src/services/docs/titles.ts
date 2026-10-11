/**
 * The page titles and banners in docsStore (contract §12.20): the node of a page from the decrypt
 * results of its title and banner, the merge of a new node into the stored one, and the rows that
 * wait for keys (createPageTitles): their retry and the catch-up of a channel whose envelopes are
 * of an epoch that the Worker does not have yet.
 *
 * Plain dependencies, so the rules are testable without a Worker or a store.
 */
import type { Page } from '@hachiman/client'
import type {
  AttachmentPointer,
  CryptoApi,
  DocDecryptResult,
  EncryptedDocItem
} from '@hachiman/crypto'
import type { PageNode } from '@/stores/docsStore'
import { parseBanner } from './banner'

const fromUtf8 = new TextDecoder('utf-8', { fatal: true })

type BannerFields = Pick<PageNode, 'banner' | 'bannerPending'>

const NO_BANNER: BannerFields = { banner: null, bannerPending: false }

/** The id of the banner item of a page in a decryptDoc batch. */
const bannerItemId = (pageId: string): string => `${pageId}:banner`

/** A page without its envelopes: the store never holds ciphertext. */
export const nodeOf = (
  p: Page,
  title: string,
  titleState: PageNode['titleState'],
  banner: BannerFields = NO_BANNER
): PageNode => ({
  id: p.id,
  channelId: p.channelId,
  parentId: p.parentId,
  position: p.position,
  createdBy: p.createdBy,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  title,
  titleState,
  banner: banner.banner,
  bannerPending: banner.bannerPending
})

/**
 * The banner of a page from the decrypt result of its banner envelope. No result: pending. A
 * banner that fails or does not parse is no banner, so an editor can replace it.
 */
function bannerOf(p: Page, r: DocDecryptResult | undefined): BannerFields {
  if (p.bannerEnvelope === null) return NO_BANNER
  if (r?.status === 'ok') return { banner: parseBanner(r.bytes), bannerPending: false }
  return r?.status === 'failed' ? NO_BANNER : { banner: null, bannerPending: true }
}

/**
 * The node of a page from the decrypt results of its title and its banner. No result: pending. A
 * pending banner does not make the title pending.
 */
export function titleNode(
  p: Page,
  r: DocDecryptResult | undefined,
  banner?: DocDecryptResult
): PageNode {
  const b = bannerOf(p, banner)
  if (r?.status === 'ok') {
    try {
      return nodeOf(p, fromUtf8.decode(r.bytes), 'ok', b)
    } catch {
      return nodeOf(p, '', 'failed', b)
    }
  }
  return nodeOf(p, '', r?.status === 'failed' ? 'failed' : 'pending', b)
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

/**
 * A banner that this device decrypted stays while a newer banner envelope of the page waits for
 * its key (a banner re-wrap or change in an epoch that the Worker did not apply yet), as
 * keepTitle. The other fields come from `next`.
 */
export function keepBanner(stored: PageNode | undefined, next: PageNode): PageNode {
  return stored?.id === next.id && stored.banner !== null && next.bannerPending
    ? { ...next, banner: stored.banner, bannerPending: false }
    : next
}

/** keepTitle and keepBanner: what `next` keeps of the stored node. */
export const keepDecrypted = (stored: PageNode | undefined, next: PageNode): PageNode =>
  keepBanner(stored, keepTitle(stored, next))

/**
 * What names the content of a banner: the file and the thumbnail with their keys and hashes. Two
 * pointers that name one upload with another key or hash are other banners.
 */
const bannerId = (p: AttachmentPointer | null): string | null =>
  p === null
    ? null
    : [
        p.uploadId,
        p.key,
        p.sha256,
        p.mime,
        p.thumbnail?.uploadId,
        p.thumbnail?.key,
        p.thumbnail?.sha256
      ].join(':')

/** The same row as the store has: a re-wrap changes only the envelopes and updatedAt. */
export const sameNode = (a: PageNode | undefined, b: PageNode): boolean =>
  a !== undefined &&
  a.id === b.id &&
  a.titleState === 'ok' &&
  b.titleState === 'ok' &&
  a.title === b.title &&
  a.channelId === b.channelId &&
  a.parentId === b.parentId &&
  a.position === b.position &&
  bannerId(a.banner) === bannerId(b.banner) &&
  a.bannerPending === b.bannerPending

/** `a` is a newer row of the page than `b`. Takusen sends ISO timestamps, which compare as strings. */
export const isNewer = (
  a: Pick<Page, 'updatedAt'> | undefined,
  b: Pick<Page, 'updatedAt'>
): boolean => a !== undefined && a.updatedAt > b.updatedAt

/**
 * The node to store for `next` (a PAGE_* event, a REST row or a retry), or null when the store
 * has it or a newer row of the page (a retry that a newer PAGE_UPDATE overtook).
 */
export function mergeNode(stored: PageNode | undefined, next: PageNode): PageNode | null {
  if (isNewer(stored, next)) return null
  const node = keepDecrypted(stored, next)
  return sameNode(stored, node) ? null : node
}

const WAITING_BANNER: BannerFields = { banner: null, bannerPending: true }

/** The title or the banner of the node waits for keys. */
const waits = (n: PageNode): boolean => n.titleState === 'pending' || n.bannerPending

export interface PageTitlesDeps {
  /** The crypto Worker. Throws while it is not ready. */
  crypto(): Pick<CryptoApi, 'decryptDoc' | 'ensureChannelGroup'>
  findPage(pageId: string): PageNode | undefined
  upsertPage(node: PageNode): void
}

export interface PageTitles {
  /**
   * The nodes of `pages` from their titles and banners. A title or banner that waits for keys
   * stays for retry(). A failure of the Worker call itself (not ready yet): both show pending.
   */
  decrypt(pages: Page[]): Promise<PageNode[]>
  /**
   * Stores `node` unless the store has it or a newer row. A decrypted title or banner stays while
   * a newer one is pending.
   */
  store(node: PageNode): void
  /** Decrypts the pending titles and banners again and stores the ones that are no longer pending. */
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
 * The titles and banners that wait for keys, with the newest row of each page. They decrypt again
 * on epochKeysAvailable, after a catch-up, and when this device joins a group (retry()).
 *
 * A title or banner is ahead when a member committed and this device did not apply the commit yet: the
 * PAGE_UPDATE of a title re-wrap or rename came before the handshake, or READY decrypts the titles
 * before the Worker syncs. The Worker does not keep doc envelopes for later, so no
 * epochKeysAvailable follows. Thus one catch-up per channel (ensureChannelGroup), then the titles
 * decrypt again. A channel that is still ahead after its catch-up waits for epochKeysAvailable,
 * READY or RESUMED, and for a decrypt of its titles with none ahead: no loop.
 */
export function createPageTitles(deps: PageTitlesDeps): PageTitles {
  /** Pages whose title or banner waits for keys, with the newest row of each. */
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
   * The titles and banners of `channelIds` were decrypted. `ahead` holds the channels with a title
   * or banner of an epoch after the current one of the Worker (pending 'epoch_ahead').
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
    // One batch: the title of each page, and the banner of each page that has one.
    const items: EncryptedDocItem[] = []
    for (const p of pages) {
      const item = { channelId: p.channelId, pageId: p.id, senderDevice: null }
      items.push({ ...item, id: p.id, kind: 'doc_title', envelope: p.titleEnvelope })
      if (p.bannerEnvelope !== null)
        items.push({
          ...item,
          id: bannerItemId(p.id),
          kind: 'doc_banner',
          envelope: p.bannerEnvelope
        })
    }
    const results = new Map(
      (await deps.crypto().decryptDoc(items)).map((r): [string, DocDecryptResult] => [r.id, r])
    )
    const nodes = pages.map((p) => titleNode(p, results.get(p.id), results.get(bannerItemId(p.id))))
    if (gen !== generation) return nodes
    const ahead = new Set<string>()
    for (const [i, p] of pages.entries()) {
      for (const r of [results.get(p.id), results.get(bannerItemId(p.id))])
        if (r?.status === 'pending' && r.reason === 'epoch_ahead') ahead.add(p.channelId)
      // A newer row of the page came in during the decrypt: the entry is the newer row's.
      if (isNewer(pending.get(p.id), p) || isNewer(deps.findPage(p.id), p)) continue
      const n = nodes[i]
      if (!n || waits(n)) pending.set(p.id, p)
      else pending.delete(p.id)
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
      return pages.map((p) =>
        nodeOf(p, '', 'pending', p.bannerEnvelope === null ? NO_BANNER : WAITING_BANNER)
      )
    }
  }

  function store(node: PageNode): void {
    const merged = mergeNode(deps.findPage(node.id), node)
    if (merged) deps.upsertPage(merged)
  }

  function retry(): void {
    if (pending.size === 0) return
    const gen = generation
    const pages = [...pending.values()]
    void decrypt(pages).then((nodes) => {
      if (gen !== generation) return
      // A node whose title or banner no longer waits.
      for (const [i, p] of pages.entries()) {
        const n = nodes[i]
        if (n && (n.titleState !== 'pending' || (p.bannerEnvelope !== null && !n.bannerPending)))
          store(n)
      }
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
