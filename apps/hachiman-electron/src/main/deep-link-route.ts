/**
 * Custom-scheme deep link → what the renderer receives (./protocol-handler.ts).
 * Free of `electron` imports so `node --test` can load it.
 *
 *  - `takusen://invite/<code>[#k=<key>]` → "invite": the link rebuilt from the
 *    URL parts and checked with the shared UI's parseInviteLink. The key is the
 *    seed of an invite with history (contract §12.11.4). A link with any other
 *    fragment is dropped (fail closed).
 *  - `app.hachiman://oauth-callback?…` → "oauth": the raw URL. The shared UI's
 *    takusenService parses code/state. Reverse-DNS scheme because RFC 8252 §7.1
 *    requires it for native OAuth redirects (panva rejects bare schemes).
 */

import { parseInviteLink } from "@hachiman/hachiman/invite-link";

export const INVITE_SCHEME = "takusen";
export const OAUTH_SCHEME = "app.hachiman";

export type DeepLink = { kind: "invite" | "oauth"; payload: string };

/** Map a raw URL to what the renderer receives, or null if it isn't ours. */
export function routeDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === `${INVITE_SCHEME}:` && url.hostname === "invite") {
    // Normalized: lowercase scheme, no query, no edge slashes. `#` alone
    // parses as an empty hash. The payload is the exact string that was checked.
    const code = url.pathname.replace(/^\/+|\/+$/g, "");
    const payload = `${INVITE_SCHEME}://invite/${code}${url.hash}`;
    return parseInviteLink(payload) ? { kind: "invite", payload } : null;
  }
  if (
    url.protocol === `${OAUTH_SCHEME}:` &&
    url.hostname === "oauth-callback"
  ) {
    return { kind: "oauth", payload: raw };
  }
  return null;
}
