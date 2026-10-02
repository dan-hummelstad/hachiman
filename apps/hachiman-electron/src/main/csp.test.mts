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
  assert.deepEqual(directive(buildCsp(PROD_ENV), "script-src"), ["'self'"]);
  assert.deepEqual(directive(buildCsp({}), "script-src"), ["'self'"]);
});

test("img-src and media-src allow only the Oracle API origin and blob: previews", () => {
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
  // A local stack serves files over plain http from the Oracle API origin.
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
  assert.deepEqual(directive(csp, "script-src"), ["'self'", "'unsafe-inline'"]);
  assert.ok(directive(csp, "connect-src").includes("ws:"));
});
