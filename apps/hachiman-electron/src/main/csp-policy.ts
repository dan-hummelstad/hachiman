/**
 * The renderer Content-Security-Policy rules (contract §11, §12.17), from resolved
 * endpoints. ./csp.ts resolves them from the Vite env for Electron main. The
 * browser host imports this file too (apps/hachiman-browser/csp.ts), so both
 * hosts send the same policy. Keep it import-free: Vite loads it while it
 * bundles the browser config, where workspace TS packages do not resolve.
 */

/** The resolved Takusen endpoints (`TakusenEnv` of `@hachiman/hachiman/takusen-env`). */
export interface CspEndpoints {
  issuer: string;
  apiBase: string;
  gatewayUrl: string;
}

export interface CspOptions {
  /** The Vite dev server URL, when the renderer comes from it. */
  devServerUrl?: string;
}

export function cspFromEndpoints(
  takusen: CspEndpoints,
  { devServerUrl }: CspOptions = {},
): string {
  const endpoints = [takusen.issuer, takusen.apiBase, takusen.gatewayUrl].map(
    (u) => new URL(u),
  );
  const connect = new Set(["'self'", ...endpoints.map((u) => u.origin)]);
  // Avatars, icons, banners and attachments come from Takusen (`/files`, §4 Files), so no other
  // remote image origin is allowed. blob: is the local preview of a picked file before upload,
  // and the object URL of a decrypted E2EE attachment (§12.17).
  const files = `'self' blob: ${new URL(takusen.apiBase).origin}`;
  // The crypto Worker and the voice transform Worker are built module files of the app
  // (§12.17). Never blob: here or in script-src, and no 'wasm-unsafe-eval': the crypto
  // code is plain TypeScript on WebCrypto.
  const workers = devServerUrl
    ? `'self' ${new URL(devServerUrl).origin}`
    : "'self'";
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
    `worker-src ${workers}`,
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
