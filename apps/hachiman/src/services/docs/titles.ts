/**
 * The page titles in docsStore (contract §12.20): the node of a page from the decrypt result of
 * its title, the merge of a new node into the stored one, and the catch-up of a channel whose
 * titles are of an epoch that the Worker does not have yet.
 *
 * Plain dependencies, so the rules are testable without a Worker or a store.
 */
import type { Page } from '@hachiman/client'
import type { DocDecryptResult } from '@hachiman/crypto'
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

/** The node to store for `next` (a PAGE_* event or a REST row), or null when the store has it. */
export function mergeNode(stored: PageNode | undefined, next: PageNode): PageNode | null {
  const node = keepTitle(stored, next)
  return sameNode(stored, node) ? null : node
}

export interface TitleCatchUpDeps {
  /** The Worker catches the group of the channel up: it fetches the handshakes that it lacks. */
  ensureChannelGroup(channelId: string): Promise<unknown>
  /** Decrypts the pending titles again. */
  retry(): void
}

export interface TitleCatchUp {
  /**
   * The titles of `channelIds` were decrypted. `ahead` holds the channels with a title of an epoch
   * after the current one of the Worker (pending 'epoch_ahead').
   */
  noteResults(channelIds: Iterable<string>, ahead: ReadonlySet<string>): void
  /** READY, RESUMED: a channel with a title that is ahead gets a catch-up again. */
  clear(): void
  /** Sign-out: no retry after this. */
  reset(): void
}

/**
 * A title is ahead when a member committed and this device did not apply the commit yet: the
 * PAGE_UPDATE of a title re-wrap or rename came before the handshake, or READY decrypts the titles
 * before the Worker syncs. The Worker does not keep doc envelopes for later, so no
 * epochKeysAvailable follows. Thus one catch-up per channel (ensureChannelGroup), then the titles
 * decrypt again. A channel that is still ahead after its catch-up waits for epochKeysAvailable,
 * READY or RESUMED, and for a decrypt of its titles with none ahead: no loop.
 */
export function createTitleCatchUp(deps: TitleCatchUpDeps): TitleCatchUp {
  /** The channels with a catch-up since their titles last decrypted with none ahead. */
  const tried = new Set<string>()
  let generation = 0

  function catchUp(channelId: string): void {
    tried.add(channelId)
    const gen = generation
    void Promise.resolve()
      .then(() => deps.ensureChannelGroup(channelId))
      .then(
        () => {
          if (gen === generation) deps.retry()
        },
        (e: unknown) => {
          // No retry follows a failure, so the next title that is ahead tries again.
          if (gen === generation) tried.delete(channelId)
          console.warn('[docs] catch-up of channel %s failed', channelId, e)
        }
      )
  }

  return {
    noteResults(channelIds, ahead) {
      for (const channelId of new Set(channelIds)) {
        if (!ahead.has(channelId)) tried.delete(channelId)
        else if (!tried.has(channelId)) catchUp(channelId)
      }
    },
    clear() {
      tried.clear()
    },
    reset() {
      generation++
      tried.clear()
    }
  }
}
