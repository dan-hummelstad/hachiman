import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CHANGE_GAP_MS, SETTLE_MS, WINDOW_MS, createPageActivity } from './PageActivityService'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(): {
  pa: ReturnType<typeof createPageActivity>
  posts: [string, string, number][]
} {
  const posts: [string, string, number][] = []
  const pa = createPageActivity({
    post: async (c, p, n) => {
      posts.push([c, p, n])
    },
    now: () => Date.now()
  })
  return { pa, posts }
}

it('posts one activity per page after the settle time, counting bursts as changes', () => {
  const { pa, posts } = setup()
  pa.noteEdit('c-pages', 'p1')
  vi.advanceTimersByTime(1_000)
  pa.noteEdit('c-pages', 'p1') // the same burst
  expect(posts).toEqual([])
  vi.advanceTimersByTime(SETTLE_MS)
  expect(posts).toEqual([['c-pages', 'p1', 1]])
  // Three bursts in the next window go into one post at its end.
  for (let i = 0; i < 3; i++) {
    pa.noteEdit('c-pages', 'p1')
    vi.advanceTimersByTime(CHANGE_GAP_MS)
  }
  vi.advanceTimersByTime(WINDOW_MS)
  expect(posts).toEqual([
    ['c-pages', 'p1', 1],
    ['c-pages', 'p1', 3]
  ])
})

it('posts at most once per page per window', () => {
  const { pa, posts } = setup()
  pa.noteEdit('c', 'p1')
  vi.advanceTimersByTime(SETTLE_MS)
  expect(posts).toHaveLength(1)
  pa.noteEdit('c', 'p1')
  vi.advanceTimersByTime(WINDOW_MS - 1)
  expect(posts).toHaveLength(1)
  vi.advanceTimersByTime(1)
  expect(posts).toEqual([
    ['c', 'p1', 1],
    ['c', 'p1', 1]
  ])
})

it('throttles each page on its own, and reset drops the waiting posts', () => {
  const { pa, posts } = setup()
  pa.noteEdit('c', 'p1')
  pa.noteEdit('c', 'p2')
  vi.advanceTimersByTime(SETTLE_MS)
  expect(posts.map((p) => p[1]).sort()).toEqual(['p1', 'p2'])
  pa.noteEdit('c', 'p1')
  pa.reset()
  vi.advanceTimersByTime(WINDOW_MS)
  expect(posts).toHaveLength(2)
})
