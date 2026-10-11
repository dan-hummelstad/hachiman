import { useCallback, useSyncExternalStore } from 'react'

/**
 * One `change` listener per query, which tells every subscriber in the same callback. With one
 * listener per component, the browser runs a microtask checkpoint between the listeners, so React
 * rendered the components one at a time: a parent and its child could disagree on the layout for
 * one render (a desktop `ContextMenuTrigger` in a mobile `ContextMenu` threw when a window got
 * wide).
 */
const queries = new Map<string, { mql: MediaQueryList; listeners: Set<() => void> }>()

function subscribeQuery(query: string, onChange: () => void): () => void {
  let entry = queries.get(query)
  if (!entry) {
    const listeners = new Set<() => void>()
    const mql = window.matchMedia(query)
    mql.addEventListener('change', () => {
      for (const notify of [...listeners]) notify()
    })
    entry = { mql, listeners }
    queries.set(query, entry)
  }
  const { listeners } = entry
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => subscribeQuery(query, onChange), [query])
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)
}
