import { parseInviteCode, type IPlatformService } from "@hachiman/hachiman";

/**
 * Listener set that buffers values emitted before anyone subscribes: the page's
 * own URL is read at startup, long before the UI mounts its effects.
 */
function buffered(): {
  emit(v: string): void;
  subscribe(cb: (v: string) => void): () => void;
} {
  const subs = new Set<(v: string) => void>();
  const pending: string[] = [];
  return {
    emit(v: string): void {
      if (subs.size === 0) pending.push(v);
      else subs.forEach((cb) => cb(v));
    },
    subscribe(cb: (v: string) => void): () => void {
      subs.add(cb);
      pending.splice(0).forEach((v) => cb(v));
      return () => void subs.delete(cb);
    },
  };
}

const inviteCodes = buffered();
const oauthCallbacks = buffered();

/**
 * Consume the load URL's deep-link routes, then reset to `/` so a reload neither
 * re-redeems the single-use OAuth code nor re-opens the invite:
 *  - `/oauth/callback?code=…&state=…` → onOAuthCallback(full URL)
 *  - `/invite/<code>`                  → onInviteCode(code)
 */
export function consumeLaunchUrl(loc: Location = window.location): void {
  const path = loc.pathname.replace(/\/+$/, "");
  const invite = parseInviteCode(loc.href);
  if (path === "/oauth/callback" && /[?&](code|error)=/.test(loc.search)) {
    oauthCallbacks.emit(loc.href);
  } else if (invite) {
    inviteCodes.emit(invite);
  } else {
    return;
  }
  window.history.replaceState(null, "", "/");
}

export const platformService: IPlatformService = {
  platform: "browser",
  insetTitleBar: false,
  // Must match a Takusen client redirect URI (apps/takusen/src/db/seed.ts); override when serving on another origin.
  oauthRedirectUri:
    import.meta.env.VITE_HACHIMAN_OIDC_REDIRECT ??
    `${window.location.origin}/oauth/callback`,
  // Same-tab redirect, so the OAuth callback lands in this app instance.
  beginOAuth: (url) => window.location.assign(url),
  onInviteCode: inviteCodes.subscribe,
  onOAuthCallback: oauthCallbacks.subscribe,
  // Browsers can't open raw sockets, so there's no honest RTT to measure.
  probeRegions: async () => [],
  getScreenSources: async () => null,
  selectScreenSource: async () => undefined,
};
