/**
 * Custom-scheme deep link → what the renderer receives (./protocol-handler.ts).
 * Free of `electron` imports so `node --test` can load it.
 *
 *  - `takusen://invite/<code>[#k=<key>]` → "invite": the link rebuilt from the
 *    checked parts. The key is the seed of an invite with history (contract
 *    §12.11.4). A link with any other fragment is dropped (fail closed).
 *  - `app.hachiman://oauth-callback?…` → "oauth": the raw URL. The shared UI's
 *    takusenService parses code/state. Reverse-DNS scheme because RFC 8252 §7.1
 *    requires it for native OAuth redirects (panva rejects bare schemes).
 */

export const INVITE_SCHEME = "takusen";
export const OAUTH_SCHEME = "app.hachiman";

// Same bounds as the shared UI's parseInviteLink (apps/hachiman/src/lib/invite-link.ts),
// which main can't import; keep the two in step.
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{2,64}$/;
// The last character of a 32-byte seed has its 2 low bits 0 (canonical base64url).
const INVITE_KEY_FRAGMENT_RE = /^#k=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

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
    const code = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!INVITE_CODE_RE.test(code)) return null;
    // `#` alone parses as an empty hash.
    if (url.hash !== "" && !INVITE_KEY_FRAGMENT_RE.test(url.hash)) return null;
    return {
      kind: "invite",
      payload: `${INVITE_SCHEME}://invite/${code}${url.hash}`,
    };
  }
  if (
    url.protocol === `${OAUTH_SCHEME}:` &&
    url.hostname === "oauth-callback"
  ) {
    return { kind: "oauth", payload: raw };
  }
  return null;
}
