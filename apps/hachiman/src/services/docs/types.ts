// The pages channel services as the UI sees them. Contract: docs/gateway-protocol.md §4 Pages, §12.20.
// The store (stores/docsStore.ts) holds the tree, titles and presence. The Yjs objects stay here.
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { DocUpdate } from '@hachiman/client'
import type { PageMove } from './page-tree'

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
  onStatus(cb: (status: DocStatus) => void): () => void
  /** Releases this handle. The provider closes when the last handle of the page closes. */
  close(): void
}

export interface DocsService {
  /** GET /channels/:id/pages, decrypts the titles into docsStore. */
  loadPages(channelId: string): Promise<void>
  /** Opens (or shares) the provider of the page and sets it as the open page of the channel. */
  openPage(channelId: string, pageId: string): Promise<DocHandle>
  /**
   * Encrypts the title, POST /channels/:id/pages as the last child of `parentId`. Resolves the
   * new page id.
   */
  createPage(channelId: string, title: string, parentId: string | null): Promise<string>
  renamePage(pageId: string, title: string): Promise<void>
  /** The PATCHes of a drop (projectDrop). 400 PageCycle rejects. */
  movePages(moves: PageMove[]): Promise<void>
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
  /**
   * The page waits for a key: status 'waiting', or a page that shows its content and stopped at
   * an update without a key. A PAGE_UPDATE of the page makes it load again (§12.20 "The new member").
   */
  readonly waitingForKeys: boolean
  /** A DOC_UPDATE for this page (ciphertext). Fills a seq gap from REST first. */
  receiveUpdate(d: Pick<DocUpdate, 'seq' | 'groupId' | 'epoch' | 'senderDevice' | 'envelope'>): void
  /** A DOC_AWARENESS for this page (ciphertext). Frames of this device are ignored. */
  receiveAwareness(d: { deviceId: string; envelope: string }): void
  /**
   * After READY or RESUMED, and when new epoch keys arrive: re-reads the tail with
   * GET /pages/:pageId/updates?after=, or loads again when the page did not load yet or stopped
   * at an update without a key (a newer snapshot can cover it).
   */
  resync(): Promise<void>
  /**
   * Waits for the load, then for the snapshot that the rules call for (none when the page is
   * current, waits for keys or is read-only). The re-wrap pass uses it on a page that is not open.
   */
  snapshotIfNeeded(): Promise<void>
  /** The gateway left 'ready': status 'offline' until the next resync. */
  markOffline(): void
  destroy(): void
}
