import type {
  InviteLink,
  IPlatformService,
  ShareContent,
} from "@hachiman/hachiman";
import { buffered } from "@hachiman/hachiman/shared/buffered.ts";
import { launchRoute } from "./launch-url";
import { createBrowserSecureStorage } from "./secure-storage";

// The page's own URL is read at startup, long before the UI mounts its effects.
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
  const route = launchRoute(loc);
  if (route === null) return;
  if (route.kind === "oauth") oauthCallbacks.emit(route.url);
  else if (route.link !== null) inviteLinks.emit(route.link);
  window.history.replaceState(null, "", "/");
}

/** The Web Share API. A dismissed sheet rejects with AbortError: that is a cancel, not an error. */
async function shareWithNavigator(content: ShareContent): Promise<boolean> {
  try {
    await navigator.share({ url: content.url, text: content.text });
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return false;
    throw e;
  }
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
  // The browser's own picker offers the audio (VoiceService asks for it).
  screenShareAudio: false,
  // Each page load gets the deployed build.
  checkForUpdate: async () => ({
    status: "not-available",
    reason: "The web app updates when you reload the page.",
  }),
  closeToTray: null,
  // A page cannot take keys from other apps.
  setGlobalShortcuts: async () => null,
  onGlobalShortcut: () => () => undefined,
  haptic: () => undefined,
  share: typeof navigator.share === "function" ? shareWithNavigator : null,
  // qr-view.tsx scans with BarcodeDetector where the browser has it.
  scanQr: null,
  setAppearance: () => undefined,
  secureStorage: createBrowserSecureStorage(),
};
