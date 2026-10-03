/**
 * Content-Security-Policy of the browser host. It is the Electron policy
 * (`apps/hachiman-electron/src/main/csp-policy.ts`, contract §11 and §12.17), so
 * both hosts send the same rules. vite.config.ts applies it.
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
export const DEV_SERVER_URL = "http://localhost:5173/";

/** Browsers ignore these directives in a `<meta>` policy and log a warning. */
const HEADER_ONLY = ["frame-ancestors", "report-uri", "sandbox"];

export interface BrowserCsp {
  /** For the `Content-Security-Policy` response header (dev server, preview, production server). */
  header: string;
  /** For the `<meta http-equiv>` tag of the built `index.html`: the header without the header-only directives. */
  meta: string;
}

export function browserCsp(
  env: Readonly<Record<string, unknown>>,
  { dev }: { dev: boolean },
): BrowserCsp {
  const header = buildCsp(env, dev ? { devServerUrl: DEV_SERVER_URL } : {});
  const meta = header
    .split("; ")
    .filter((d) => !HEADER_ONLY.includes(d.split(" ")[0]))
    .join("; ");
  return { header, meta };
}
