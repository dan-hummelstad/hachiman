/**
 * Page activity (N21 item 3): when this user edits a page, post "edited <page> · n changes" as a
 * 'page_activity' message into the pages channel of the page. At most one post per page per
 * WINDOW_MS from this client. A "change" is a burst of edits: edits less than CHANGE_GAP_MS apart
 * count once.
 */
import { MAX_PAGE_ACTIVITY_CHANGES } from '@hachiman/crypto'

/** At most one post per page in this time. */
export const WINDOW_MS = 10 * 60_000
/** The first post of a window waits this long, so a burst of edits goes into one post. */
export const SETTLE_MS = 30_000
/** Edits closer than this are one change. */
export const CHANGE_GAP_MS = 30_000

export interface PageActivityDeps {
  post(channelId: string, pageId: string, changes: number): Promise<void>
  now?(): number
}

export interface PageActivity {
  /** A local edit of the page reached the server. */
  noteEdit(channelId: string, pageId: string): void
  /** Sign-out: drops the counts and the timers. Nothing is posted. */
  reset(): void
}

interface Entry {
  channelId: string
  changes: number
  lastEdit: number
  lastPost: number
  timer: ReturnType<typeof setTimeout> | null
}

export function createPageActivity(deps: PageActivityDeps): PageActivity {
  const now = deps.now ?? Date.now
  const pages = new Map<string, Entry>()

  const fire = (pageId: string): void => {
    const e = pages.get(pageId)
    if (!e) return
    e.timer = null
    if (e.changes === 0) return
    const changes = Math.min(e.changes, MAX_PAGE_ACTIVITY_CHANGES)
    e.changes = 0
    e.lastPost = now()
    void deps.post(e.channelId, pageId, changes).catch((err: unknown) => {
      console.warn('[pages] page activity post failed', err)
    })
  }

  return {
    noteEdit(channelId, pageId) {
      const t = now()
      let e = pages.get(pageId)
      if (!e) {
        e = { channelId, changes: 0, lastEdit: -Infinity, lastPost: -Infinity, timer: null }
        pages.set(pageId, e)
      }
      e.channelId = channelId
      if (t - e.lastEdit >= CHANGE_GAP_MS) e.changes++
      e.lastEdit = t
      if (e.timer !== null) return
      const due = Math.max(e.lastPost + WINDOW_MS, t + SETTLE_MS)
      e.timer = setTimeout(() => fire(pageId), due - t)
    },
    reset() {
      for (const e of pages.values()) if (e.timer !== null) clearTimeout(e.timer)
      pages.clear()
    }
  }
}
