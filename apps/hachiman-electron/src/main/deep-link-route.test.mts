/**
 * Unit tests for the deep-link routing of main (invite links and the OAuth callback).
 * Run via the package `test` script (node's test runner + native TS type-stripping).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { routeDeepLink } from "./deep-link-route.ts";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

test("an invite link without a key gives the bare link", () => {
  assert.deepEqual(routeDeepLink("takusen://invite/nt0wl5x"), {
    kind: "invite",
    payload: "takusen://invite/nt0wl5x",
  });
  assert.deepEqual(routeDeepLink("takusen://invite/nt0wl5x/?x=1#"), {
    kind: "invite",
    payload: "takusen://invite/nt0wl5x",
  });
});

test("an invite link keeps a well-formed key of an invite with history", () => {
  assert.deepEqual(routeDeepLink(`takusen://invite/nt0wl5x#k=${KEY}`), {
    kind: "invite",
    payload: `takusen://invite/nt0wl5x#k=${KEY}`,
  });
  // Rebuilt from the checked parts: the query does not reach the renderer.
  assert.deepEqual(routeDeepLink(`takusen://invite/nt0wl5x/?a=b#k=${KEY}`), {
    kind: "invite",
    payload: `takusen://invite/nt0wl5x#k=${KEY}`,
  });
});

// The full malformed-key table is in @hachiman/client (invite-link.spec.ts).
test("an invite link with a malformed key or another fragment is dropped", () => {
  for (const fragment of ["#k=", "#section"]) {
    assert.equal(
      routeDeepLink(`takusen://invite/nt0wl5x${fragment}`),
      null,
      fragment,
    );
  }
});

test("a bad invite code is dropped", () => {
  for (const raw of [
    "takusen://invite/",
    "takusen://invite/a",
    "takusen://invite/a%20b",
    "takusen://invite/nt0wl5x/extra",
    "takusen://join/nt0wl5x",
  ]) {
    assert.equal(routeDeepLink(raw), null, raw);
  }
});

test("the OAuth callback passes as the raw URL", () => {
  const raw = "app.hachiman://oauth-callback?code=c&state=s";
  assert.deepEqual(routeDeepLink(raw), { kind: "oauth", payload: raw });
  assert.equal(routeDeepLink("app.hachiman://other?code=c"), null);
});

test("other URLs and non-URLs are not ours", () => {
  for (const raw of [
    "https://takusen.example/invite/nt0wl5x",
    "--inspect",
    "/usr/bin/electron",
    "",
  ]) {
    assert.equal(routeDeepLink(raw), null, raw);
  }
});
