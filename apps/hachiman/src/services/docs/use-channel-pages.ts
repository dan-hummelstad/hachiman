import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { create } from 'zustand'
import type { Channel } from '@hachiman/client'
import { useAction } from '@/hooks/use-action'
import { errMsg } from '@/lib/utils'
import { docsService } from '@/services/docs/DocsService'
import { useDocsStore, type PageNode } from '@/stores/docsStore'
import { navigate } from '@/stores/navStore'

/**
 * The pages of a pages channel for the mobile layout: the page list that the pages drawer (M42)
 * and the chat's page bar (M37) share, and what they keep for this session.
 */

/**
 * What the pages of a channel keep for this session, in memory only: the pages whose sub-pages
 * the drawer hides, and the page opened last, which the chat's page bar names.
 */
interface PagesSession {
  collapsed: ReadonlyMap<string, ReadonlySet<string>>
  lastPage: ReadonlyMap<string, string>
}

const usePagesSession = create<PagesSession>()(() => ({
  collapsed: new Map(),
  lastPage: new Map()
}))

const EMPTY_SET: ReadonlySet<string> = new Set()
const EMPTY_PAGES: PageNode[] = []

/** The page opened last in the channel in this session, or null. */
export const useLastPageId = (channelId: string): string | null =>
  usePagesSession((s) => s.lastPage.get(channelId) ?? null)

/** Notes the page that is open in the channel (the chat's page bar names it). */
export function rememberPage(channelId: string, pageId: string): void {
  usePagesSession.setState((s) =>
    s.lastPage.get(channelId) === pageId
      ? s
      : { lastPage: new Map(s.lastPage).set(channelId, pageId) }
  )
}

/** The pages of the channel whose sub-pages the pages drawer hides. */
export const useCollapsedPages = (channelId: string): ReadonlySet<string> =>
  usePagesSession((s) => s.collapsed.get(channelId) ?? EMPTY_SET)

/** Hides (`collapse`) or shows the sub-pages of a page in the pages drawer. */
export function setPageCollapsed(channelId: string, pageId: string, collapse: boolean): void {
  usePagesSession.setState((s) => {
    const set = s.collapsed.get(channelId) ?? EMPTY_SET
    if (set.has(pageId) === collapse) return s
    const next = new Set(set)
    if (collapse) next.add(pageId)
    else next.delete(pageId)
    return { collapsed: new Map(s.collapsed).set(channelId, next) }
  })
}

/** The page lists that load now, so that two views of a channel load it once. */
const loading = new Map<string, Promise<void>>()

/**
 * The pages of a pages channel, loaded at the first use: `failed` holds the error of a load that
 * failed.
 */
export function useChannelPages(channelId: string): {
  pages: PageNode[]
  loaded: boolean
  failed: string | null
} {
  const { pages, loaded } = useDocsStore(
    useShallow((s) => ({
      pages: s.pagesByChannel.get(channelId) ?? EMPTY_PAGES,
      loaded: s.pagesByChannel.has(channelId)
    }))
  )
  const [failed, setFailed] = useState<{ channelId: string; message: string } | null>(null)
  useEffect(() => {
    if (useDocsStore.getState().pagesByChannel.has(channelId)) return
    let live = true
    let load = loading.get(channelId)
    if (!load) {
      load = docsService.loadPages(channelId).finally(() => loading.delete(channelId))
      loading.set(channelId, load)
    }
    load.catch((e) => {
      if (live) setFailed({ channelId, message: errMsg(e) })
    })
    return () => {
      live = false
    }
  }, [channelId])
  return { pages, loaded, failed: failed?.channelId === channelId ? failed.message : null }
}

/**
 * Creates an "Untitled" page at the end of the channel's root pages and opens it (the page
 * screen). For members with SEND_MESSAGES: the page bar of an empty channel and the channel start.
 */
export function useNewPage(channel: Channel): {
  create: () => void
  busy: boolean
  error: string | null
} {
  const { run, busy, error } = useAction()
  const create = (): void => {
    const guildId = channel.guildId
    if (guildId === null) return
    void run('create the page', () => docsService.createPage(channel.id, 'Untitled', null)).then(
      (r) => {
        if (r.ok) navigate({ kind: 'page', guildId, channelId: channel.id, pageId: r.value })
      }
    )
  }
  return { create, busy, error }
}
