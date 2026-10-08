/**
 * Unit tests for the browser host CSP (./csp.ts). The policy rules have their
 * own tests in apps/hachiman-electron/src/main/csp.test.mts; these check that the
 * browser host sends the same policy and that the meta form drops header-only
 * directives. Run via the package `test` script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCsp } from "../hachiman-electron/src/main/csp.ts";
import { browserCsp, DEV_SERVER_URL } from "./csp.ts";

const ENV = {
  VITE_TAKUSEN_OIDC_ISSUER: "https://id.example.com/api/oidc",
  VITE_TAKUSEN_API_BASE: "https://api.example.com/api",
  VITE_HACHIMAN_GATEWAY_URL: "wss://gw.example.com/gateway",
};

const directive = (csp: string, name: string): string[] | undefined =>
  csp
    .split("; ")
    .find((d) => d.startsWith(`${name} `))
    ?.split(" ")
    .slice(1);

test("production header is the Electron packaged policy", () => {
  assert.equal(browserCsp(ENV, { dev: false }).header, buildCsp(ENV));
});

test("dev header is the Electron dev-server policy for :5173", () => {
  assert.equal(
    browserCsp(ENV, { dev: true }).header,
    buildCsp(ENV, { devServerUrl: DEV_SERVER_URL }),
  );
  assert.deepEqual(
    directive(browserCsp(ENV, { dev: true }).header, "worker-src"),
    ["'self'", "http://localhost:5173"],
  );
});

test("meta form drops frame-ancestors and keeps every other directive", () => {
  const { header, meta } = browserCsp(ENV, { dev: false });
  assert.deepEqual(directive(header, "frame-ancestors"), ["'none'"]);
  assert.equal(directive(meta, "frame-ancestors"), undefined);
  assert.deepEqual(
    meta.split("; "),
    header.split("; ").filter((d) => !d.startsWith("frame-ancestors ")),
  );
});

test("E2EE rules hold in the browser policy (§12.17)", () => {
  for (const dev of [false, true]) {
    const { header } = browserCsp(ENV, { dev });
    assert.ok(directive(header, "worker-src")?.includes("'self'"));
    assert.ok(directive(header, "img-src")?.includes("blob:"));
    assert.ok(directive(header, "media-src")?.includes("blob:"));
    assert.ok(!directive(header, "script-src")?.includes("blob:"));
    assert.ok(!directive(header, "worker-src")?.includes("blob:"));
    assert.ok(!directive(header, "script-src")?.includes("'unsafe-eval'"));
  }
});
