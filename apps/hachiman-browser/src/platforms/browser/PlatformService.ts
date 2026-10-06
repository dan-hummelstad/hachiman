import {
  parseInviteLink,
  type InviteLink,
  type IPlatformService,
} from "@hachiman/hachiman";
import { launchRoute } from "./launch-url";
import { createBrowserSecureStorage } from "./secure-storage";

/**
 * Listener set that buffers values emitted before anyone subscribes: the page's
 * own URL is read at startup, long before the UI mounts its effects.
 */
function buffered<T>(): {
  emit(v: T): void;
  subscribe(cb: (v: T) => void): () => void;
} {
  const subs = new Set<(v: T) => void>();
  const pending: T[] = [];
  return {
    emit(v: T): void {
      if (subs.size === 0) pending.push(v);
      else subs.forEach((cb) => cb(v));
    },
    subscribe(cb: (v: T) => void): () => void {
      subs.add(cb);
      pending.splice(0).forEach((v) => cb(v));
      return () => void subs.delete(cb);
    },
  };
}

const inviteLinks = buffered<InviteLink>();
const oauthCallbacks = buffered<string>();

/**
 * Consume the load URL's deep-link routes, then reset to `/` so a reload neither
 * re-redeems the single-use OAuth code nor re-opens the invite:
 *  - `/oauth/callback?code=…&state=…` → onOAuthCallback(full URL)
 *  - `/invite/<code>[#k=<key>]`        → onInviteLink({ code, key })
 * The reset also removes the key of an invite with history from the address
 * bar and the history entry. A link with a malformed key opens nothing.
 */
export function consumeLaunchUrl(loc: Location = window.location): void {
  const route = launchRoute(loc, parseInviteLink);
  if (route === null) return;
  if (route.kind === "oauth") oauthCallbacks.emit(route.url);
  else if (route.link !== null) inviteLinks.emit(route.link);
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
  onInviteLink: inviteLinks.subscribe,
  onOAuthCallback: oauthCallbacks.subscribe,
  // Browsers can't open raw sockets, so there's no honest RTT to measure.
  probeRegions: async () => [],
  getScreenSources: async () => null,
  selectScreenSource: async () => undefined,
  // Each page load gets the deployed build.
  checkForUpdate: async () => ({
    status: "not-available",
    reason: "The web app updates when you reload the page.",
  }),
  secureStorage: createBrowserSecureStorage(),
};
