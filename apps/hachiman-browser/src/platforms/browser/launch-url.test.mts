/**
 * Tests for the load-URL routes of the browser host (./launch-url.ts). The
 * invite grammar has its own tests in @hachiman/client (invite-link.spec.ts).
 * Run via the package `test` script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchRoute } from "./launch-url.ts";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

const route = (href: string): ReturnType<typeof launchRoute> => {
  const url = new URL(href);
  return launchRoute({ pathname: url.pathname, search: url.search, href });
};

test("an invite link opens with its key", () => {
  assert.deepEqual(route("https://app.example/invite/nt0wl5x"), {
    kind: "invite",
    link: { code: "nt0wl5x", key: null },
  });
  assert.deepEqual(route(`https://app.example/invite/nt0wl5x/#k=${KEY}`), {
    kind: "invite",
    link: { code: "nt0wl5x", key: KEY },
  });
});

test("an invite link with a malformed key is a route that opens nothing", () => {
  for (const fragment of ["#k=", "#section"]) {
    assert.deepEqual(
      route(`https://app.example/invite/nt0wl5x${fragment}`),
      { kind: "invite", link: null },
      fragment,
    );
  }
  // Also a bad or missing code: the URL resets either way.
  for (const href of [
    "https://app.example/invite/a%20b/extra",
    `https://app.example/invite/#k=${KEY}`,
    `https://app.example/invite#k=${KEY}`,
  ]) {
    assert.deepEqual(route(href), { kind: "invite", link: null }, href);
  }
});

test("the OAuth callback passes as the full URL", () => {
  const href = "https://app.example/oauth/callback?code=c&state=s";
  assert.deepEqual(route(href), { kind: "oauth", url: href });
  const failed = "https://app.example/oauth/callback/?error=access_denied";
  assert.deepEqual(route(failed), { kind: "oauth", url: failed });
});

test("other URLs are not routes", () => {
  for (const href of [
    "https://app.example/",
    "https://app.example/?preview",
    "https://app.example/oauth/callback",
    "https://app.example/invites",
    "https://app.example/channels/x#k=" + KEY,
  ]) {
    assert.equal(route(href), null, href);
  }
});
