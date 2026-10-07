import type { Channel } from '@hachiman/client'
import { flattenPages, pageTitle } from '@/services/docs/page-tree'
import type { PageNode } from '@/stores/docsStore'

/** `hachiman:page/<uuid>`: the page link format (components/docs/page-links.ts). */
const PAGE_LINK = /hachiman:page\/([0-9a-f-]{36})/gi

/** The number of distinct pages that the texts link to (the count on the Pages tab, N21.1). */
export function countPageLinks(texts: Iterable<string>): number {
  const ids = new Set<string>()
  for (const t of texts) for (const m of t.matchAll(PAGE_LINK)) ids.add((m[1] ?? '').toLowerCase())
  return ids.size
}

/** One pages channel in the guild pages list, with its pages in tree order. */
export interface GuildPagesSection {
  channel: Channel
  /** Unset while the channel's pages are not loaded. */
  pages?: { page: PageNode; depth: number }[]
}

/**
 * The pages of the given pages channels for the Pages tab of a text channel (N21.1), in tree
 * order. With a query, only the pages whose title contains it (case-insensitive), flat, and
 * the channels without a match are left out.
 */
export function guildPagesSections(
  channels: readonly Channel[],
  pagesByChannel: ReadonlyMap<string, PageNode[]>,
  query: string
): GuildPagesSection[] {
  const q = query.trim().toLowerCase()
  const out: GuildPagesSection[] = []
  for (const channel of channels) {
    const list = pagesByChannel.get(channel.id)
    if (!list) {
      if (q === '') out.push({ channel })
      continue
    }
    const flat = flattenPages(list)
    const pages =
      q === ''
        ? flat
        : flat
            .filter((f) => pageTitle(f.page).toLowerCase().includes(q))
            .map((f) => ({ page: f.page, depth: 0 }))
    if (q === '' || pages.length > 0) out.push({ channel, pages })
  }
  return out
}

/** The default width of the page column (C1), restored by a double-click on its edge. */
export const PAGE_COLUMN_DEFAULT = 540
const PAGE_COLUMN_MIN = 360
/** What the chat beside the page keeps at least, with the sidebar and the gaps. */
const CHAT_MIN = 640

/** The page column width clamped to its minimum and to what leaves the chat room in `windowWidth`. */
export function clampPageColumn(width: number, windowWidth: number): number {
  const max = Math.max(PAGE_COLUMN_MIN, windowWidth - CHAT_MIN)
  return Math.round(Math.min(Math.max(width, PAGE_COLUMN_MIN), max))
}
