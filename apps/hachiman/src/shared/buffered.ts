/**
 * A listener set that holds the values emitted before anyone subscribes, and gives them to the
 * first subscriber. Hosts use it for launch values (deep links, OAuth callbacks) that arrive
 * before the UI mounts its effects. No imports, so `node --test` in a host can load it.
 */
export function buffered<T>(): {
  emit(v: T): void
  subscribe(cb: (v: T) => void): () => void
} {
  const subs = new Set<(v: T) => void>()
  const pending: T[] = []
  return {
    emit(v: T): void {
      if (subs.size === 0) pending.push(v)
      else subs.forEach((cb) => cb(v))
    },
    subscribe(cb: (v: T) => void): () => void {
      subs.add(cb)
      pending.splice(0).forEach((v) => cb(v))
      return () => void subs.delete(cb)
    }
  }
}
