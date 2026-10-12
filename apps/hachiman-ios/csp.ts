/**
 * Content-Security-Policy of the iOS host. It is the Electron policy
 * (`apps/hachiman-electron/src/main/csp-policy.ts`, contract §11 and §12.17), as
 * in the browser host (`apps/hachiman-browser/csp.ts`). The app runs on
 * `hachiman://app` (the WKURLSchemeHandler), so `'self'` covers the bundled files.
 * vite.config.ts applies it: as the header of the dev server, and in the build as
 * `csp-header.txt` (the header of every scheme handler response) plus a meta tag.
 *
 * Relative imports only: Vite bundles the config with this file, and a bare
 * workspace import (`@hachiman/hachiman/takusen-env`) would load as raw TS and fail.
 */
import { cspFromEndpoints } from "../hachiman-electron/src/main/csp-policy.ts";
import { resolveTakusenEnv } from "../hachiman/src/shared/takusen-env.ts";

const buildCsp = (
  env: Readonly<Record<string, unknown>>,
  opts: { devServerUrl?: string } = {},
): string => cspFromEndpoints(resolveTakusenEnv(env), opts);

/** The fixed dev server origin (vite.config.ts `server.port`). */
export const DEV_SERVER_URL = "http://localhost:5175/";

/** WebKit ignores these directives in a `<meta>` policy and logs a warning. */
const HEADER_ONLY = ["frame-ancestors", "report-uri", "sandbox"];

export interface IosCsp {
  /** For the `Content-Security-Policy` header: the dev server, and in the build `csp-header.txt`, which the WKURLSchemeHandler sends. */
  header: string;
  /** For the `<meta http-equiv>` tag of the built `index.html` (the WebApp/ bundle). */
  meta: string;
}

export function iosCsp(
  env: Readonly<Record<string, unknown>>,
  { dev }: { dev: boolean },
): IosCsp {
  const header = buildCsp(env, dev ? { devServerUrl: DEV_SERVER_URL } : {});
  const meta = header
    .split("; ")
    .filter((d) => !HEADER_ONLY.includes(d.split(" ")[0]))
    .join("; ");
  return { header, meta };
}
