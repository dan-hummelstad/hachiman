// The pages channel services as the UI sees them. Contract: docs/gateway-protocol.md §4 Pages, §12.20.
// The store (stores/docsStore.ts) holds the tree, titles and presence. The Yjs objects stay here.
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { DocUpdate } from '@hachiman/client'

/**
 * - loading: reading the snapshot and the updates.
 * - waiting: no snapshot of the current epoch can be read yet ("Waiting for a member to share this page").
 * - ready: the doc is live; local edits are sent.
 * - offline: the gateway is not ready. Edits queue and go out after the catch-up.
 * - error: the page cannot be read (deleted, no access, failed decrypt of the snapshot).
 */
export type DocStatus = 'loading' | 'waiting' | 'ready' | 'offline' | 'error'

/** One open page. `doc` and `awareness` bind to the editor (@milkdown/plugin-collab). */
export interface DocHandle {
  readonly channelId: string
  readonly pageId: string
  readonly doc: Y.Doc
  readonly awareness: Awareness
  readonly status: DocStatus
  /** Calls `cb` on each status change. Returns the unsubscribe. */
  onStatus(cb: (status: DocStatus) => void): () => void
  /** Releases this handle. The provider closes when the last handle of the page closes. */
  close(): void
}

/** The page that a new page or a move goes to. `position` defaults to the end of the siblings. */
export interface PagePlacement {
  parentId: string | null
  position?: number
}

export interface DocsService {
  /** GET /channels/:id/pages, decrypts the titles into docsStore. */
  loadPages(channelId: string): Promise<void>
  /** Opens (or shares) the provider of the page and sets it as the open page of the channel. */
  openPage(channelId: string, pageId: string): Promise<DocHandle>
  /** Encrypts the title, POST /channels/:id/pages. Resolves the new page id. */
  createPage(channelId: string, title: string, at: PagePlacement): Promise<string>
  renamePage(pageId: string, title: string): Promise<void>
  /** 400 PageCycle rejects. */
  movePage(pageId: string, to: Required<PagePlacement>): Promise<void>
  /** Deletes the page and its subtree. */
  deletePage(pageId: string): Promise<void>
  /** The editor of an open page registers its markdown export (Crepe getMarkdown). null unregisters. */
  setMarkdownSource(pageId: string, source: (() => string) | null): void
  /** The markdown of an open page, or null when no editor registered a source. */
  copyMarkdown(pageId: string): string | null
}

/**
 * One Y.Doc and one Awareness per open page: load, batch (100 ms), encrypt, send, apply remote
 * updates, fill seq gaps, post snapshots. DocsService routes the gateway events to it.
 */
export interface DocProvider extends Omit<DocHandle, 'close'> {
  /** A DOC_UPDATE for this page (ciphertext). Fills a seq gap from REST first. */
  receiveUpdate(d: Pick<DocUpdate, 'seq' | 'groupId' | 'epoch' | 'senderDevice' | 'envelope'>): void
  /** A DOC_AWARENESS for this page (ciphertext). Frames of this device are ignored. */
  receiveAwareness(d: { deviceId: string; envelope: string }): void
  /**
   * After READY or RESUMED, and when new epoch keys arrive: re-reads the tail with
   * GET /pages/:pageId/updates?after=, or loads again when the page did not load yet.
   */
  resync(): Promise<void>
  /** The gateway left 'ready': status 'offline' until the next resync. */
  markOffline(): void
  destroy(): void
}
