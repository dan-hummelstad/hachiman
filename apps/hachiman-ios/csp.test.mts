/**
 * Unit tests for the iOS host CSP (./csp.ts). The policy rules have their own
 * tests in apps/hachiman-electron/src/main/csp.test.mts; these check that the iOS
 * host sends the same policy and that the meta form drops header-only
 * directives. Run via the package `test` script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCsp } from "../hachiman-electron/src/main/csp.ts";
import { iosCsp, DEV_SERVER_URL } from "./csp.ts";

const ENV = {
  VITE_TAKUSEN_OIDC_ISSUER: "https://id.example.com/api/oidc",
  VITE_TAKUSEN_API_BASE: "https://api.example.com/api",
  VITE_HACHIMAN_GATEWAY_URL: "wss://gw.example.com/gateway",
};

test("production header is the Electron packaged policy", () => {
  assert.equal(iosCsp(ENV, { dev: false }).header, buildCsp(ENV));
});

test("dev header is the Electron dev-server policy for :5175", () => {
  assert.equal(
    iosCsp(ENV, { dev: true }).header,
    buildCsp(ENV, { devServerUrl: DEV_SERVER_URL }),
  );
});

test("meta drops frame-ancestors and keeps no inline script", () => {
  const { meta } = iosCsp(ENV, { dev: false });
  assert.ok(!meta.includes("frame-ancestors"));
  assert.match(meta, /script-src 'self' 'wasm-unsafe-eval'(;|$)/);
});
