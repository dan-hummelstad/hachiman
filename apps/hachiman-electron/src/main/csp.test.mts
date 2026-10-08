/**
 * Unit tests for the renderer Content-Security-Policy (./csp.ts).
 * Run via the package `test` script (node's test runner + native TS type-stripping).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCsp } from "./csp.ts";

const directive = (csp: string, name: string): string[] =>
  csp
    .split("; ")
    .find((d) => d.startsWith(`${name} `))
    ?.split(" ")
    .slice(1) ?? [];

const PROD_ENV = {
  VITE_TAKUSEN_OIDC_ISSUER: "https://id.example.com/api/oidc",
  VITE_TAKUSEN_API_BASE: "https://api.example.com/api",
  VITE_HACHIMAN_GATEWAY_URL: "wss://gw.example.com/gateway",
};

test("packaged: connect-src follows the env plus wss:, no ws:", () => {
  const csp = buildCsp(PROD_ENV);
  assert.deepEqual(directive(csp, "connect-src"), [
    "'self'",
    "https://id.example.com",
    "https://api.example.com",
    "wss://gw.example.com",
    "wss:",
  ]);
  assert.ok(!csp.includes("localhost"));
});

test("packaged: script-src has no 'unsafe-inline'", () => {
  const scripts = ["'self'", "'wasm-unsafe-eval'"];
  assert.deepEqual(directive(buildCsp(PROD_ENV), "script-src"), scripts);
  assert.deepEqual(directive(buildCsp({}), "script-src"), scripts);
});

test("img-src and media-src allow only the Takusen API origin and blob: previews", () => {
  const csp = buildCsp(PROD_ENV);
  assert.deepEqual(directive(csp, "img-src"), [
    "'self'",
    "blob:",
    "https://api.example.com",
    "data:",
  ]);
  assert.deepEqual(directive(csp, "media-src"), [
    "'self'",
    "blob:",
    "https://api.example.com",
  ]);
  // A local stack serves files over plain http from the Takusen API origin.
  assert.ok(
    directive(buildCsp({}), "img-src").includes("http://localhost:3000"),
  );
  assert.ok(
    directive(buildCsp({}), "media-src").includes("http://localhost:3000"),
  );
});

test("hardening directives are present", () => {
  const csp = buildCsp(PROD_ENV);
  assert.deepEqual(directive(csp, "font-src"), ["'self'", "data:"]);
  assert.deepEqual(directive(csp, "object-src"), ["'none'"]);
  assert.deepEqual(directive(csp, "form-action"), ["'none'"]);
  assert.deepEqual(directive(csp, "frame-ancestors"), ["'none'"]);
});

test("defaults (local stack, e.g. electron-vite preview) allow ws: without a dev server", () => {
  assert.deepEqual(directive(buildCsp({}), "connect-src"), [
    "'self'",
    "http://localhost:3000",
    "ws://localhost:8080",
    "wss:",
    "ws:",
  ]);
});

test("dev server: inline scripts (Fast Refresh preamble) and ws: (HMR) allowed", () => {
  const csp = buildCsp(PROD_ENV, { devServerUrl: "http://localhost:5173/" });
  assert.deepEqual(directive(csp, "script-src"), [
    "'self'",
    "'wasm-unsafe-eval'",
    "'unsafe-inline'",
  ]);
  assert.ok(directive(csp, "connect-src").includes("ws:"));
});

test("worker-src allows only the app's own module Workers (§12.17)", () => {
  assert.deepEqual(directive(buildCsp(PROD_ENV), "worker-src"), ["'self'"]);
  assert.deepEqual(directive(buildCsp({}), "worker-src"), ["'self'"]);
  const dev = buildCsp(PROD_ENV, { devServerUrl: "http://localhost:5174/" });
  assert.deepEqual(directive(dev, "worker-src"), [
    "'self'",
    "http://localhost:5174",
  ]);
});

test("E2EE: blob: only for images and media, never for scripts or Workers; wasm only, no eval", () => {
  const dev = { devServerUrl: "http://localhost:5174/" };
  for (const csp of [
    buildCsp(PROD_ENV),
    buildCsp({}),
    buildCsp(PROD_ENV, dev),
  ]) {
    assert.ok(directive(csp, "img-src").includes("blob:"));
    assert.ok(directive(csp, "media-src").includes("blob:"));
    for (const name of ["script-src", "worker-src", "default-src"]) {
      const values = directive(csp, name);
      assert.ok(values.length > 0, `${name} is present`);
      assert.ok(!values.includes("blob:"), `${name} has no blob:`);
      assert.ok(!values.includes("data:"), `${name} has no data:`);
      assert.ok(!values.includes("*"), `${name} has no wildcard`);
    }
    // The RNNoise worklet compiles wasm; JS eval stays blocked.
    assert.ok(directive(csp, "script-src").includes("'wasm-unsafe-eval'"));
    assert.ok(!directive(csp, "script-src").includes("'unsafe-eval'"));
    assert.ok(!directive(csp, "worker-src").includes("'wasm-unsafe-eval'"));
  }
});
