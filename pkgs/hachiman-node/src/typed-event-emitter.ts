// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventsMap = Record<string, (...args: any[]) => void>;

type EventNames<Map extends EventsMap> = keyof Map & (string | symbol);

export type EventParams<
  Map extends EventsMap,
  Ev extends EventNames<Map>,
> = Parameters<Map[Ev]>;

export interface TypedEventBroadcaster<EmitEvents extends EventsMap> {
  emit<Ev extends EventNames<EmitEvents>>(
    ev: Ev,
    ...args: EventParams<EmitEvents, Ev>
  ): boolean;
}

/**
 * Minimal browser-safe event emitter. Previously extended `node:events`,
 * which broke the browser/Electron-renderer bundles by emitting `require()`
 * calls. The surface used by the rest of this package is small enough that
 * carrying our own implementation is cheaper than pulling in a polyfill or
 * `eventemitter3`.
 *
 * Semantics match `node:events.EventEmitter` for the subset used: synchronous
 * dispatch in registration order, `once` self-removes after firing, `off` /
 * `removeAllListeners` are no-ops when the event has no listeners.
 */
export abstract class TypedEventEmitter<
  ListenEvents extends EventsMap,
  EmitEvents extends EventsMap,
> implements TypedEventBroadcaster<EmitEvents> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _listeners = new Map<
    string | symbol,
    ((...args: any[]) => void)[]
  >();

  on<EventName extends EventNames<ListenEvents>>(
    eventName: EventName,
    listener: ListenEvents[EventName],
  ): this {
    const arr = this._listeners.get(eventName) ?? [];
    arr.push(listener);
    this._listeners.set(eventName, arr);
    return this;
  }

  once<EventName extends EventNames<ListenEvents>>(
    eventName: EventName,
    listener: ListenEvents[EventName],
  ): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = ((...args: any[]) => {
      this.off(eventName, wrapped);
      (listener as (...a: unknown[]) => void)(...args);
    }) as ListenEvents[EventName];
    return this.on(eventName, wrapped);
  }

  off<EventName extends EventNames<ListenEvents>>(
    eventName: EventName,
    listener: ListenEvents[EventName],
  ): this {
    const arr = this._listeners.get(eventName);
    if (!arr) return this;
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
    if (arr.length === 0) this._listeners.delete(eventName);
    return this;
  }

  removeListener<EventName extends EventNames<ListenEvents>>(
    eventName: EventName,
    listener: ListenEvents[EventName],
  ): this {
    return this.off(eventName, listener);
  }

  removeAllListeners<EventName extends EventNames<ListenEvents>>(
    eventName?: EventName,
  ): this {
    if (eventName === undefined) {
      this._listeners.clear();
    } else {
      this._listeners.delete(eventName);
    }
    return this;
  }

  emit<EventName extends EventNames<EmitEvents>>(
    eventName: EventName,
    ...args: EventParams<EmitEvents, EventName>
  ): boolean {
    const arr = this._listeners.get(eventName);
    if (!arr || arr.length === 0) return false;
    // Snapshot so once-handlers removing themselves mid-iteration are safe.
    for (const fn of arr.slice()) {
      (fn as (...a: unknown[]) => void)(...args);
    }
    return true;
  }

  listeners<EventName extends EventNames<ListenEvents>>(
    event: EventName,
  ): ListenEvents[EventName][] {
    return (
      this._listeners.get(event) ?? []
    ).slice() as ListenEvents[EventName][];
  }
}
