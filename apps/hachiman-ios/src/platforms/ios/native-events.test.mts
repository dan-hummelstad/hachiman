/**
 * Tests for the native → JS events of the iOS host (./native-events.ts). Run via
 * the package `test` script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNativeEvents,
  installNativeEvents,
  type NativeEmitter,
} from "./native-events.ts";

test("events before the first subscriber are held per type, in order", () => {
  const ev = createNativeEvents();
  ev.emit("oauth-callback", { url: "a" });
  ev.emit("invite-link", { url: "i" });
  ev.emit("oauth-callback", { url: "b" });

  const oauth: string[] = [];
  ev.on("oauth-callback", ({ url }) => oauth.push(url));
  assert.deepEqual(oauth, ["a", "b"]);

  // The other type stays held until its own subscriber.
  const invites: string[] = [];
  ev.on("invite-link", ({ url }) => invites.push(url));
  assert.deepEqual(invites, ["i"]);
});

test("a subscriber gets live events, and a held event goes to one subscriber only", () => {
  const ev = createNativeEvents();
  ev.emit("invite-link", { url: "held" });
  const first: string[] = [];
  const second: string[] = [];
  ev.on("invite-link", ({ url }) => first.push(url));
  const off = ev.on("invite-link", ({ url }) => second.push(url));
  ev.emit("invite-link", { url: "live" });
  assert.deepEqual(first, ["held", "live"]);
  assert.deepEqual(second, ["live"]);

  off();
  ev.emit("invite-link", { url: "after" });
  assert.deepEqual(second, ["live"]);
  assert.deepEqual(first, ["held", "live", "after"]);
});

test("events are held again when every subscriber has left", () => {
  const ev = createNativeEvents();
  const off = ev.on("oauth-callback", () => assert.fail("unsubscribed"));
  off();
  ev.emit("oauth-callback", { url: "x" });
  const got: string[] = [];
  ev.on("oauth-callback", ({ url }) => got.push(url));
  assert.deepEqual(got, ["x"]);
});

test("unknown types and bad payloads are dropped", () => {
  const ev = createNativeEvents();
  ev.emit("something-else", { url: "x" });
  ev.emit("oauth-callback", "x");
  ev.emit("oauth-callback", { url: 1 });
  ev.emit("oauth-callback", null);
  const got: unknown[] = [];
  ev.on("oauth-callback", (p) => got.push(p));
  assert.deepEqual(got, []);
});

test("the payload handed on carries only the url", () => {
  const ev = createNativeEvents();
  ev.emit("oauth-callback", { url: "u", extra: true });
  ev.on("oauth-callback", (p) => assert.deepEqual(p, { url: "u" }));
});

test("installNativeEvents defines one fixed emitter on the target", () => {
  const target: { __hachimanNative?: NativeEmitter } = {};
  const ev = installNativeEvents(target);
  assert.equal(target.__hachimanNative, ev);
  assert.equal(installNativeEvents(target), ev);
  assert.throws(() => {
    (target as { __hachimanNative?: unknown }).__hachimanNative = {};
  });

  // Native's call shape: window.__hachimanNative.emit(type, payload).
  target.__hachimanNative!.emit("invite-link", { url: "takusen://invite/x" });
  const got: string[] = [];
  ev.on("invite-link", ({ url }) => got.push(url));
  assert.deepEqual(got, ["takusen://invite/x"]);
});

test("importing the module installs the emitter on globalThis", () => {
  assert.equal(
    typeof (globalThis as { __hachimanNative?: NativeEmitter }).__hachimanNative
      ?.emit,
    "function",
  );
});
