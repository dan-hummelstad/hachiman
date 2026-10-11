import { useShallow } from 'zustand/react/shallow'
import type { AttachmentPointer } from '@hachiman/crypto'
import { rootOf } from '@/services/docs/page-tree'
import { useDocsStore, type PageNode } from '@/stores/docsStore'

/** The banner that a page shows: the banner of its top-level page (§12.20 doc_banner). */
export interface PageBannerState {
  /** The top-level page above the page (itself on a top-level page). null: none, as for an orphan. */
  rootId: string | null
  /** The page is the top-level page: the one place where an editor changes the banner. */
  isRoot: boolean
  /** The decrypted pointer, the stored reference. Show it only through useDecryptedBlob. */
  banner: AttachmentPointer | null
  /**
   * False while the pages of the channel are not loaded or the root's banner waits for keys:
   * render nothing then, so that "Add banner" does not flicker. A pending title does not count.
   */
  known: boolean
}

/** The banner state of `pageId` from the page list of its channel (undefined: not loaded). */
export function pageBannerState(
  pages: readonly PageNode[] | undefined,
  pageId: string
): PageBannerState {
  if (!pages) return { rootId: null, isRoot: false, banner: null, known: false }
  const rootId = rootOf(pages, pageId)
  const root = rootId === null ? undefined : pages.find((p) => p.id === rootId)
  return {
    rootId,
    isRoot: rootId !== null && rootId === pageId,
    banner: root?.banner ?? null,
    known: root?.bannerPending !== true
  }
}

/** The banner of the page `pageId` of the pages channel `channelId`. */
export function usePageBanner(channelId: string, pageId: string): PageBannerState {
  return useDocsStore(useShallow((s) => pageBannerState(s.pagesByChannel.get(channelId), pageId)))
}
