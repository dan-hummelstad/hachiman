/**
 * The pages of each pages channel (contract §4 Pages): the tree with decrypted titles in docsStore,
 * the PAGE_* mirror, and one DocProvider per open page with a reference count. Decrypt before
 * store: a title envelope never reaches the store, only its text or a pending/failed state.
 */
import type { GatewayEvents, Page } from '@hachiman/client'
import type * as Y from 'yjs'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/hachiman'
import { currentDeviceId } from '@/stores/cryptoStore'
import { resetDocsStore, useDocsStore, type PageNode } from '@/stores/docsStore'
import { useUserStore } from '@/stores/userStore'
import { createDocProvider, type DocProviderDeps } from './DocProvider'
import { collectMediaUploadIds } from './media'
import type { DocHandle, DocProvider, DocsService, PagePlacement } from './types'

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder('utf-8', { fatal: true })

/** A stable cursor color per user. */
export function userColor(userId: string): string {
  let h = 0
  for (const c of userId) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const hue = h % 360
  const f = (n: number): string => {
    const k = (n + hue / 30) % 12
    const v = 0.5 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

let mediaCollector: (doc: Y.Doc) => string[] = collectMediaUploadIds

/** The media worker of pages registers how to find the page_media upload ids in a doc. */
export function setMediaCollector(fn: (doc: Y.Doc) => string[]): void {
  mediaCollector = fn
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
  online: () => hachiman.gateway.state === 'ready',
  setPresence: (pageId, peers) => useDocsStore.getState().setPresence(pageId, peers),
  collectMediaUploadIds: (doc) => mediaCollector(doc)
}

interface Open {
  provider: DocProvider
  refs: number
}

const open = new Map<string, Open>()
const markdown = new Map<string, () => string>()
/** Pages whose title waits for keys: retried on epochKeysAvailable. */
const pendingTitles = new Map<string, Page>()
let generation = 0

/** A page without its envelope: the store never holds ciphertext. */
const nodeOf = (p: Page, title: string, titleState: PageNode['titleState']): PageNode => ({
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

async function decryptTitles(pages: Page[]): Promise<PageNode[]> {
  if (pages.length === 0) return []
  const results = await cryptoService.client().decryptDoc(
    pages.map((p) => ({
      id: p.id,
      channelId: p.channelId,
      pageId: p.id,
      kind: 'doc_title' as const,
      senderDevice: null,
      envelope: p.titleEnvelope
    }))
  )
  return pages.map((p, i) => {
    const r = results[i]
    if (r?.status === 'ok') {
      pendingTitles.delete(p.id)
      try {
        return nodeOf(p, fromUtf8.decode(r.bytes), 'ok')
      } catch {
        return nodeOf(p, '', 'failed')
      }
    }
    if (r?.status === 'failed') {
      pendingTitles.delete(p.id)
      return nodeOf(p, '', 'failed')
    }
    pendingTitles.set(p.id, p)
    return nodeOf(p, '', 'pending')
  })
}

/** Decrypt failures of the Worker call itself (not ready yet): the titles show pending. */
async function nodesOf(pages: Page[]): Promise<PageNode[]> {
  try {
    return await decryptTitles(pages)
  } catch (e) {
    console.warn('[docs] titles not decrypted', e)
    for (const p of pages) pendingTitles.set(p.id, p)
    return pages.map((p) => nodeOf(p, '', 'pending'))
  }
}

const findPage = (pageId: string): PageNode | undefined => {
  for (const pages of useDocsStore.getState().pagesByChannel.values()) {
    const p = pages.find((x) => x.id === pageId)
    if (p) return p
  }
  return undefined
}

const endPosition = (channelId: string, parentId: string | null): number => {
  const siblings = (useDocsStore.getState().pagesByChannel.get(channelId) ?? []).filter(
    (p) => p.parentId === parentId
  )
  return siblings.reduce((max, p) => Math.max(max, p.position + 1), 0)
}

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

async function upsertFromEvent(page: Page): Promise<void> {
  // A channel that the UI never loaded gets its whole list on the first loadPages.
  if (!useDocsStore.getState().pagesByChannel.has(page.channelId)) return
  const gen = generation
  const [node] = await nodesOf([page])
  if (node && gen === generation) useDocsStore.getState().upsertPage(node)
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
  /** Sign-out. */
  reset(): void
} = {
  async loadPages(channelId) {
    const gen = generation
    const pages = await hachiman.rest.getPages(channelId)
    const nodes = await nodesOf(pages)
    if (gen === generation) useDocsStore.getState().setPages(channelId, nodes)
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

  async createPage(channelId, title, at) {
    const id = crypto.randomUUID()
    const position = at.position ?? endPosition(channelId, at.parentId)
    const titleEnvelope = await encryptTitle(channelId, id, title)
    const page = await hachiman.rest.createPage(channelId, {
      id,
      parentId: at.parentId,
      position,
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

  async movePage(pageId, to: Required<PagePlacement>) {
    await upsertFromEvent(
      await hachiman.rest.updatePage(pageId, { parentId: to.parentId, position: to.position })
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
  },

  onPageDelete(d) {
    useDocsStore.getState().removePages(d.channelId, d.ids)
    for (const id of d.ids) {
      pendingTitles.delete(id)
      closePage(id)
    }
  },

  onDocUpdate(d) {
    open.get(d.pageId)?.provider.receiveUpdate(d)
  },

  onDocAwareness(d) {
    open.get(d.pageId)?.provider.receiveAwareness(d)
  },

  onChannelDelete(channelId) {
    for (const [id, o] of open) if (o.provider.channelId === channelId) closePage(id)
    for (const [id, p] of pendingTitles) if (p.channelId === channelId) pendingTitles.delete(id)
    useDocsStore.getState().removeChannel(channelId)
  },

  onReady(full) {
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
    if (pendingTitles.size > 0) {
      const gen = generation
      void nodesOf([...pendingTitles.values()]).then((nodes) => {
        if (gen !== generation) return
        for (const n of nodes) if (n.titleState !== 'pending') useDocsStore.getState().upsertPage(n)
      })
    }
    for (const o of open.values()) void o.provider.resync()
  },

  reset() {
    generation++
    for (const id of [...open.keys()]) closePage(id)
    pendingTitles.clear()
    markdown.clear()
    resetDocsStore()
  }
}
