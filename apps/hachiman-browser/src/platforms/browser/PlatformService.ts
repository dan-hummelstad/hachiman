import type {
  InviteLink,
  IPlatformService,
  PushTarget,
  ShareContent,
} from "@hachiman/hachiman";
import { buffered } from "@hachiman/hachiman/shared/buffered.ts";
import { launchRoute } from "./launch-url";
import { createBrowserSecureStorage } from "./secure-storage";

// The page's own URL is read at startup, long before the UI mounts its effects.
const inviteLinks = buffered<InviteLink>();
const oauthCallbacks = buffered<string>();
const pushOpens = buffered<string>();

// A click on a push in public/sw.js while a tab is open: the worker focuses the tab and names
// the channel. The page talks only to its own service worker.
navigator.serviceWorker?.addEventListener("message", (e: MessageEvent) => {
  const d = e.data as { op?: unknown; channelId?: unknown } | null;
  if (d?.op === "open-channel" && typeof d.channelId === "string")
    pushOpens.emit(d.channelId);
});

/**
 * Consume the load URL's deep-link routes, then reset to `/` so a reload neither
 * re-redeems the single-use OAuth code nor re-opens the invite:
 *  - `/oauth/callback?code=…&state=…` → onOAuthCallback(full URL)
 *  - `/invite/<code>[#k=<key>]`        → onInviteLink({ code, key })
 *  - `/?channel=<id>` (a push tap)     → onPushOpen(id)
 * The reset also removes the key of an invite with history from the address
 * bar and the history entry. A link with a malformed key opens nothing.
 */
export function consumeLaunchUrl(loc: Location = window.location): void {
  const route = launchRoute(loc);
  if (route === null) return;
  if (route.kind === "oauth") oauthCallbacks.emit(route.url);
  else if (route.kind === "channel") pushOpens.emit(route.channelId);
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

const b64u = (buf: ArrayBuffer | null): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf ?? new ArrayBuffer(0))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** A new push key from the service worker, which keeps its private half (public/sw.js). */
function workerPushKey(
  worker: ServiceWorker,
  deviceId: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) =>
      typeof data?.pushKey === "string"
        ? resolve(data.pushKey)
        : reject(new Error(String(data?.error ?? "no push key")));
    worker.postMessage({ op: "push-key", deviceId }, [channel.port2]);
  });
}

/**
 * Web Push through `/sw.js` (public/sw.js). Takusen encrypts each push to the subscription keys
 * (`p256dh`, `auth`, RFC 8291), and inside it the sender's preview is sealed to the push key of
 * the service worker (§12.22). Null when the browser has no Push API or the user refused.
 */
async function subscribeWebPush(
  vapidPublicKey: string,
  deviceId: string,
): Promise<PushTarget | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window))
    return null;
  if ((await Notification.requestPermission()) !== "granted") return null;
  const reg = await navigator.serviceWorker.register("/sw.js");
  const ready = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(
    atob(vapidPublicKey.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  let sub = await reg.pushManager.getSubscription();
  // A subscription of another key (Takusen made a new VAPID key) cannot receive.
  const old = sub?.options.applicationServerKey;
  const same = old != null && new Uint8Array(old).every((b, i) => b === key[i]);
  if (sub && !same) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const worker = ready.active ?? reg.active;
  if (!worker) return null;
  return {
    kind: "webpush",
    endpoint: sub.endpoint,
    p256dh: b64u(sub.getKey("p256dh")),
    auth: b64u(sub.getKey("auth")),
    pushKey: await workerPushKey(worker, deviceId),
  };
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
  // The UI downloads a blob.
  saveTextFile: null,
  pushSubscribe: subscribeWebPush,
  onPushOpen: pushOpens.subscribe,
  setAppearance: () => undefined,
  secureStorage: createBrowserSecureStorage(),
};
