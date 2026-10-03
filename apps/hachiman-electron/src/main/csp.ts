/**
 * Content-Security-Policy for the renderer, built from the same Vite env the
 * renderer reads (`VITE_TAKUSEN_*`, `VITE_HACHIMAN_GATEWAY_URL`; electron-vite
 * exposes `VITE_*` to main too). Main sends it as a response header
 * (./renderer-protocol.ts). The rules are in ./csp-policy.ts.
 */
import { resolveTakusenEnv } from "@hachiman/hachiman/takusen-env";
import { cspFromEndpoints, type CspOptions } from "./csp-policy.ts";

export type { CspOptions };

export function buildCsp(
  env: Readonly<Record<string, unknown>>,
  options: CspOptions = {},
): string {
  return cspFromEndpoints(resolveTakusenEnv(env), options);
}
