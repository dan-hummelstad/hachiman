import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Page } from '@hachiman/client'

/** The decrypt state of a page title (doc_title envelope, §12.20). */
export type PageTitleState = 'ok' | 'pending' | 'failed'

/** A page as rendered: the decrypted title, never the title envelope. */
export interface PageNode extends Omit<Page, 'titleEnvelope'> {
  /** '' while the title does not decrypt. */
  title: string
  titleState: PageTitleState
}

/** One remote viewer of a page, from its decrypted awareness state. */
export interface DocPeer {
  /** The Yjs awareness client id. */
  clientId: number
  userId: string
  name: string
  color: string
}

interface DocsState {
  /** channelId → the pages of the channel (flat), sorted by parentId, then position. Unset = never loaded. */
  pagesByChannel: Map<string, PageNode[]>
  /** channelId → the page open in the pages panel. */
  openPageByChannel: Map<string, string>
  /** pageId → the remote viewers. */
  presence: Map<string, DocPeer[]>
  setPages: (channelId: string, pages: PageNode[]) => void
  upsertPage: (page: PageNode) => void
  /** Removes pages by id (a delete and its subtree). Clears the open page when it is one of them. */
  removePages: (channelId: string, ids: string[]) => void
  setOpenPage: (channelId: string, pageId: string | null) => void
  setPresence: (pageId: string, peers: DocPeer[]) => void
  /** A channel delete: drops its pages, open page and presence. */
  removeChannel: (channelId: string) => void
}

const byTree = (a: PageNode, b: PageNode): number =>
  (a.parentId ?? '').localeCompare(b.parentId ?? '') ||
  a.position - b.position ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.id.localeCompare(b.id)

type DocsData = Pick<DocsState, 'pagesByChannel' | 'openPageByChannel' | 'presence'>

const initialDocsState = (): DocsData => ({
  pagesByChannel: new Map(),
  openPageByChannel: new Map(),
  presence: new Map()
})

export const useDocsStore = create<DocsState>()(
  devtools((set) => ({
    ...initialDocsState(),
    setPages: (channelId, pages) =>
      set((s) => ({
        pagesByChannel: new Map(s.pagesByChannel).set(channelId, [...pages].sort(byTree))
      })),
    upsertPage: (page) =>
      set((s) => {
        const list = (s.pagesByChannel.get(page.channelId) ?? []).filter((p) => p.id !== page.id)
        list.push(page)
        list.sort(byTree)
        return { pagesByChannel: new Map(s.pagesByChannel).set(page.channelId, list) }
      }),
    removePages: (channelId, ids) =>
      set((s) => {
        const gone = new Set(ids)
        const list = s.pagesByChannel.get(channelId)
        const presence = new Map(s.presence)
        for (const id of ids) presence.delete(id)
        const open = s.openPageByChannel.get(channelId)
        const openPageByChannel = new Map(s.openPageByChannel)
        if (open !== undefined && gone.has(open)) openPageByChannel.delete(channelId)
        return {
          pagesByChannel: list
            ? new Map(s.pagesByChannel).set(
                channelId,
                list.filter((p) => !gone.has(p.id))
              )
            : s.pagesByChannel,
          openPageByChannel,
          presence
        }
      }),
    setOpenPage: (channelId, pageId) =>
      set((s) => {
        const openPageByChannel = new Map(s.openPageByChannel)
        if (pageId === null) openPageByChannel.delete(channelId)
        else openPageByChannel.set(channelId, pageId)
        return { openPageByChannel }
      }),
    setPresence: (pageId, peers) =>
      set((s) => ({ presence: new Map(s.presence).set(pageId, peers) })),
    removeChannel: (channelId) =>
      set((s) => {
        const pagesByChannel = new Map(s.pagesByChannel)
        const presence = new Map(s.presence)
        for (const p of pagesByChannel.get(channelId) ?? []) presence.delete(p.id)
        pagesByChannel.delete(channelId)
        const openPageByChannel = new Map(s.openPageByChannel)
        openPageByChannel.delete(channelId)
        return { pagesByChannel, openPageByChannel, presence }
      })
  }))
)

/** A page of any loaded pages channel. */
export function findPage(pageId: string): PageNode | undefined {
  for (const list of useDocsStore.getState().pagesByChannel.values()) {
    const page = list.find((p) => p.id === pageId)
    if (page) return page
  }
  return undefined
}

export function resetDocsStore(): void {
  useDocsStore.setState(initialDocsState())
}
