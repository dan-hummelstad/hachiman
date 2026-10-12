/**
 * Native → JS events of the iOS host. Native calls
 * `window.__hachimanNative.emit(type, payload)` through `evaluateJavaScript`
 * (Hachiman/Bridge.swift). Native holds its events until the page sends the op
 * `ready`; this side holds each type until its first subscriber (`buffered()` of
 * the shared UI, as the browser host), because the UI subscribes in effects after mount.
 *
 * Importing this module defines `window.__hachimanNative`, so main.tsx imports it first.
 */
import { buffered } from "@hachiman/hachiman/shared/buffered.ts";

export interface NativeEventMap {
  /** The `app.hachiman://oauth-callback?…` URL from ASWebAuthenticationSession. */
  "oauth-callback": { url: string };
  /** A `takusen://invite/…` URL from `onOpenURL`. */
  "invite-link": { url: string };
}

export type NativeEventType = keyof NativeEventMap;

export interface NativeEmitter {
  emit(type: string, payload: unknown): void;
}

export interface NativeEvents extends NativeEmitter {
  /** Delivers the held events of `type` to `cb` at once. Returns unsubscribe. */
  on<K extends NativeEventType>(
    type: K,
    cb: (payload: NativeEventMap[K]) => void,
  ): () => void;
}

function isPayload(v: unknown): v is { url: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { url?: unknown }).url === "string"
  );
}

export function createNativeEvents(): NativeEvents {
  const channels = {
    "oauth-callback": buffered<NativeEventMap["oauth-callback"]>(),
    "invite-link": buffered<NativeEventMap["invite-link"]>(),
  } satisfies { [K in NativeEventType]: unknown };
  return {
    emit(type, payload) {
      // Unknown types and bad payloads are dropped: nothing else may reach a subscriber.
      if (!Object.hasOwn(channels, type) || !isPayload(payload)) return;
      channels[type as NativeEventType].emit({ url: payload.url });
    },
    on: (type, cb) => channels[type].subscribe(cb),
  };
}

/** Defines `target.__hachimanNative` once (a second import keeps the first emitter). */
export function installNativeEvents(
  target: { __hachimanNative?: NativeEmitter } = globalThis as {
    __hachimanNative?: NativeEmitter;
  },
): NativeEvents {
  const existing = target.__hachimanNative;
  if (existing && "on" in existing) return existing as NativeEvents;
  const events = createNativeEvents();
  Object.defineProperty(target, "__hachimanNative", {
    value: events,
    configurable: false,
    writable: false,
    enumerable: false,
  });
  return events;
}

export const nativeEvents: NativeEvents = installNativeEvents();
