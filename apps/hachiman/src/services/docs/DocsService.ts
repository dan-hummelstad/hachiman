/**
 * The pages of each pages channel (contract §4 Pages): the tree with decrypted titles in docsStore
 * (titles.ts), the PAGE_* mirror, one DocProvider per open page with a reference count, and the
 * re-wrap pass for new members (rewrap.ts). Decrypt before store: a title envelope never reaches
 * the store, only its text or a pending/failed state.
 */
import { userHue } from '@/lib/user-tint'
import type { GatewayEvents, Page } from '@hachiman/client'
import type { CryptoEvents } from '@hachiman/crypto'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/client'
import { currentDeviceId } from '@/stores/cryptoStore'
import { findPage, resetDocsStore, useDocsStore } from '@/stores/docsStore'
import { useUserStore } from '@/stores/userStore'
import { createDocProvider, type DocProviderDeps } from './DocProvider'
import { collectMediaUploadIds, forgetCopiedMedia } from './media'
import { endPosition } from './page-tree'
import { createRewrapper, pagesChannelsOf, snapshotHeadless } from './rewrap'
import { createPageTitles, keepTitle } from './titles'
import type { DocHandle, DocProvider, DocsService } from './types'

const utf8 = new TextEncoder()

/** A stable cursor color per user. */
export function userColor(userId: string): string {
  const hue = userHue(userId)
  const f = (n: number): string => {
    const k = (n + hue / 30) % 12
    const v = 0.5 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

const providerDeps: DocProviderDeps = {
  get rest() {
    return hachiman.rest
  },
  crypto: () => cryptoService.client(),
  sendAwareness: (d) => hachiman.gateway.sendDocAwareness(d),
  deviceId: currentDeviceId,
  me: () => {
    const me = useUserStore.getState().me
    return me ? { userId: me.id, name: me.username, color: userColor(me.id) } : null
  },
  online: () => useUserStore.getState().gatewayState === 'ready',
  setPresence: (pageId, peers) => useDocsStore.getState().setPresence(pageId, peers),
  collectMediaUploadIds
}

interface Open {
  provider: DocProvider
  refs: number
}

const open = new Map<string, Open>()
const markdown = new Map<string, () => string>()
/** The providers of the re-wrap pass that run: reset() destroys them. */
const headless = new Set<Pick<DocProvider, 'destroy'>>()
let generation = 0

/** The titles that wait for keys, their retry and the catch-up of a channel (titles.ts). */
const titles = createPageTitles({
  crypto: () => cryptoService.client(),
  findPage,
  upsertPage: (node) => useDocsStore.getState().upsertPage(node)
})

async function encryptTitle(channelId: string, pageId: string, title: string): Promise<string> {
  const out = await cryptoService.client().encryptDoc({
    channelId,
    pageId,
    kind: 'doc_title',
    bytes: utf8.encode(title.trim() || 'Untitled')
  })
  return out.envelope
}

function closePage(pageId: string): void {
  const o = open.get(pageId)
  if (!o) return
  open.delete(pageId)
  markdown.delete(pageId)
  o.provider.destroy()
}

const rewrapper = createRewrapper({
  get rest() {
    return hachiman.rest
  },
  crypto: () => cryptoService.client(),
  channelsOf: (groupId) =>
    pagesChannelsOf(hachiman.cache.channels.values(), groupId, (id) => hachiman.permissionsFor(id)),
  resyncOpen: (pageId) => {
    const o = open.get(pageId)
    if (o) void o.provider.resync()
    return o !== undefined
  },
  snapshotPage: (channelId, pageId) =>
    snapshotHeadless(
      createDocProvider(channelId, pageId, providerDeps, { headless: true }),
      headless
    )
})

async function upsertFromEvent(page: Page): Promise<void> {
  // A channel that the UI never loaded gets its whole list on the first loadPages.
  if (!useDocsStore.getState().pagesByChannel.has(page.channelId)) return
  const gen = generation
  const [node] = await titles.decrypt([page])
  if (node && gen === generation) titles.store(node)
}

export const docsService: DocsService & {
  onPageEvent(d: GatewayEvents['PAGE_CREATE']): void
  onPageDelete(d: GatewayEvents['PAGE_DELETE']): void
  onDocUpdate(d: GatewayEvents['DOC_UPDATE']): void
  onDocAwareness(d: GatewayEvents['DOC_AWARENESS']): void
  onChannelDelete(channelId: string): void
  /** READY: the page lists again (PAGE_* events may be lost). READY and RESUMED: the open pages catch up. */
  onReady(full: boolean): void
  onOffline(): void
  /** New epoch keys: pending titles and waiting pages try again. */
  retry(): void
  /** This device joined a group (Welcome, external join, create): as retry(). */
  onMembership(e: CryptoEvents['membership']): void
  /** A commit added a user to a text group: the re-wrap pass of its pages channels (rewrap.ts). */
  onUsersAdded(e: CryptoEvents['usersAdded']): void
  /** Sign-out. */
  reset(): void
} = {
  async loadPages(channelId) {
    const gen = generation
    const pages = await hachiman.rest.getPages(channelId)
    const nodes = await titles.decrypt(pages)
    if (gen !== generation) return
    const stored = new Map(
      (useDocsStore.getState().pagesByChannel.get(channelId) ?? []).map((p) => [p.id, p])
    )
    useDocsStore.getState().setPages(
      channelId,
      nodes.map((n) => keepTitle(stored.get(n.id), n))
    )
  },

  openPage(channelId, pageId) {
    let o = open.get(pageId)
    if (!o) {
      o = { provider: createDocProvider(channelId, pageId, providerDeps), refs: 0 }
      open.set(pageId, o)
    }
    o.refs++
    useDocsStore.getState().setOpenPage(channelId, pageId)
    const { provider } = o
    let closed = false
    const handle: DocHandle = {
      channelId,
      pageId,
      doc: provider.doc,
      awareness: provider.awareness,
      get status() {
        return provider.status
      },
      onStatus: (cb) => provider.onStatus(cb),
      close() {
        if (closed) return
        closed = true
        const cur = open.get(pageId)
        if (cur?.provider !== provider) return
        if (--cur.refs <= 0) closePage(pageId)
      }
    }
    return Promise.resolve(handle)
  },

  async createPage(channelId, title, parentId) {
    const id = crypto.randomUUID()
    const pages = useDocsStore.getState().pagesByChannel.get(channelId) ?? []
    const titleEnvelope = await encryptTitle(channelId, id, title)
    const page = await hachiman.rest.createPage(channelId, {
      id,
      parentId,
      position: endPosition(pages, parentId),
      titleEnvelope
    })
    await upsertFromEvent(page)
    return id
  },

  async renamePage(pageId, title) {
    const page = findPage(pageId)
    if (!page) throw new Error('unknown page')
    const titleEnvelope = await encryptTitle(page.channelId, pageId, title)
    await upsertFromEvent(await hachiman.rest.updatePage(pageId, { titleEnvelope }))
  },

  async movePages(moves) {
    // Independent PATCHes: each one upserts the row that Takusen returns, so on a failure the
    // store shows what the server has.
    await Promise.all(
      moves.map(async ({ pageId, parentId, position }) =>
        upsertFromEvent(await hachiman.rest.updatePage(pageId, { parentId, position }))
      )
    )
  },

  async deletePage(pageId) {
    const page = findPage(pageId)
    await hachiman.rest.deletePage(pageId)
    // PAGE_DELETE removes the subtree too; this removes the page at once.
    if (page) useDocsStore.getState().removePages(page.channelId, [pageId])
    closePage(pageId)
  },

  setMarkdownSource(pageId, source) {
    if (source) markdown.set(pageId, source)
    else markdown.delete(pageId)
  },

  copyMarkdown(pageId) {
    return markdown.get(pageId)?.() ?? null
  },

  onPageEvent(d) {
    void upsertFromEvent(d)
    open.get(d.id)?.provider.pageChanged()
  },

  onPageDelete(d) {
    useDocsStore.getState().removePages(d.channelId, d.ids)
    titles.forget(d.ids)
    for (const id of d.ids) closePage(id)
  },

  onDocUpdate(d) {
    open.get(d.pageId)?.provider.receiveUpdate(d)
  },

  onDocAwareness(d) {
    open.get(d.pageId)?.provider.receiveAwareness(d)
  },

  onChannelDelete(channelId) {
    for (const [id, o] of open) if (o.provider.channelId === channelId) closePage(id)
    titles.forgetChannel(channelId)
    useDocsStore.getState().removeChannel(channelId)
  },

  onReady(full) {
    // The Worker syncs after READY and RESUMED: a title that is ahead gets a catch-up again.
    titles.onReady()
    if (full)
      for (const channelId of useDocsStore.getState().pagesByChannel.keys())
        void docsService
          .loadPages(channelId)
          .catch((e: unknown) => console.warn('[docs] reload failed', e))
    for (const o of open.values()) void o.provider.resync()
  },

  onOffline() {
    for (const o of open.values()) o.provider.markOffline()
  },

  retry() {
    titles.retry()
    for (const o of open.values()) void o.provider.resync()
  },

  onMembership(e) {
    // A title of a group that this device has not joined is pending 'group_unknown'. The Worker
    // does not keep doc envelopes, so no epochKeysAvailable follows the join. The event of a join
    // lists the whole roster, this device too.
    const me = currentDeviceId()
    if (e.kind !== 'removed' && me !== null && e.subjects.some((s) => s.deviceId === me))
      docsService.retry()
  },

  onUsersAdded(e) {
    rewrapper.onUsersAdded(e)
  },

  reset() {
    generation++
    rewrapper.reset()
    titles.reset()
    for (const p of headless) p.destroy()
    headless.clear()
    for (const id of [...open.keys()]) closePage(id)
    markdown.clear()
    forgetCopiedMedia()
    resetDocsStore()
  }
}
