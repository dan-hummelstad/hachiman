// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventsMap = Record<string, (...args: any[]) => void>

type EventNames<M extends EventsMap> = keyof M & string

export type EventParams<M extends EventsMap, E extends EventNames<M>> = Parameters<M[E]>

/**
 * Minimal browser-safe event emitter (no `node:events`, which breaks renderer bundles).
 * Synchronous dispatch in registration order; `once` self-removes; `off` on an unknown
 * listener is a no-op. `EmitEvents` defaults to `ListenEvents`.
 */
export class TypedEventEmitter<ListenEvents extends EventsMap, EmitEvents extends EventsMap = ListenEvents> {
  private readonly _listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  on<E extends EventNames<ListenEvents>>(event: E, listener: ListenEvents[E]): this {
    const arr = this._listeners.get(event) ?? []
    arr.push(listener)
    this._listeners.set(event, arr)
    return this
  }

  once<E extends EventNames<ListenEvents>>(event: E, listener: ListenEvents[E]): this {
    const wrapped = ((...args: unknown[]) => {
      this.off(event, wrapped)
      ;(listener as (...a: unknown[]) => void)(...args)
    }) as ListenEvents[E]
    return this.on(event, wrapped)
  }

  off<E extends EventNames<ListenEvents>>(event: E, listener: ListenEvents[E]): this {
    const arr = this._listeners.get(event)
    if (!arr) return this
    const idx = arr.indexOf(listener)
    if (idx >= 0) arr.splice(idx, 1)
    if (arr.length === 0) this._listeners.delete(event)
    return this
  }

  removeListener<E extends EventNames<ListenEvents>>(event: E, listener: ListenEvents[E]): this {
    return this.off(event, listener)
  }

  removeAllListeners(event?: EventNames<ListenEvents>): this {
    if (event === undefined) this._listeners.clear()
    else this._listeners.delete(event)
    return this
  }

  emit<E extends EventNames<EmitEvents>>(event: E, ...args: EventParams<EmitEvents, E>): boolean {
    const arr = this._listeners.get(event)
    if (!arr?.length) return false
    // Snapshot so once-handlers removing themselves mid-iteration are safe.
    for (const fn of arr.slice()) fn(...args)
    return true
  }

  listeners<E extends EventNames<ListenEvents>>(event: E): ListenEvents[E][] {
    return (this._listeners.get(event) ?? []).slice() as ListenEvents[E][]
  }
}
