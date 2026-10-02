/**
 * Content-Security-Policy for the renderer, built from the same Vite env the
 * renderer reads (`VITE_TAKUSEN_*`, `VITE_HACHIMAN_GATEWAY_URL`; electron-vite
 * exposes `VITE_*` to main too). Main sends it as a response header
 * (./renderer-protocol.ts).
 */
import { resolveOracleEnv } from "@hachiman/hachiman/oracle-env";

export interface CspOptions {
  /** electron-vite dev server URL, when the renderer comes from it. */
  devServerUrl?: string;
}

export function buildCsp(
  env: Readonly<Record<string, unknown>>,
  { devServerUrl }: CspOptions = {},
): string {
  const oracle = resolveOracleEnv(env);
  const endpoints = [oracle.issuer, oracle.apiBase, oracle.gatewayUrl].map(
    (u) => new URL(u),
  );
  const connect = new Set(["'self'", ...endpoints.map((u) => u.origin)]);
  // Avatars, icons, banners and attachments come from Oracle (`/files`, §4 Files), so no other
  // remote image origin is allowed; blob: is the local preview of a picked file before upload.
  const files = `'self' blob: ${new URL(oracle.apiBase).origin}`;
  // Media nodes are placed per region, so their voice WS host is not known at build time.
  connect.add("wss:");
  // A local (plain-text) stack places local media nodes on ws:, and Vite's HMR
  // socket is ws: too. Allow ws: only when some endpoint is already plain text.
  const all = [...endpoints, ...(devServerUrl ? [new URL(devServerUrl)] : [])];
  if (all.some((u) => u.protocol === "ws:" || u.protocol === "http:")) {
    connect.add("ws:");
  }
  // Dev only: @vitejs/plugin-react injects an inline Fast Refresh preamble.
  const scripts = devServerUrl ? "'self' 'unsafe-inline'" : "'self'";

  return [
    "default-src 'self'",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${files} data:`,
    `media-src ${files}`,
    "font-src 'self' data:",
    `connect-src ${[...connect].join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
