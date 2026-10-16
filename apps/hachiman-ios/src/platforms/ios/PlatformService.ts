import type { IPlatformService } from "@hachiman/hachiman";
import { parseInviteLink } from "@hachiman/hachiman/invite-link";
import {
  secureStorageErrorCode,
  type SecureStorageErrorCode,
} from "@hachiman/hachiman/shared/IPlatformService.ts";
import { call as nativeCall, type BridgeCall } from "./bridge.ts";
import { nativeEvents, type NativeEvents } from "./native-events.ts";

/** The callback scheme of ASWebAuthenticationSession (Hachiman/OAuth.swift); a seeded Takusen redirect URI. */
export const IOS_OAUTH_REDIRECT_URI = "app.hachiman://oauth-callback";

/**
 * The iOS `IPlatformService` (contract §11) over the native bridge. `call` and
 * `events` are parameters so `node --test` can pass fakes.
 */
export function createIosPlatformService(
  call: BridgeCall,
  events: NativeEvents,
): IPlatformService {
  const report =
    (what: string) =>
    (e: unknown): void =>
      console.error(`[platform] ${what}`, e);

  return {
    platform: "ios",
    insetTitleBar: false,
    oauthRedirectUri: IOS_OAUTH_REDIRECT_URI,
    // ASWebAuthenticationSession; the redirect comes back as the `oauth-callback` event.
    beginOAuth: (url) => {
      call("oauth.begin", { url }).catch(
        report("could not open the sign-in page"),
      );
    },
    // Native sends the raw `takusen://invite/…` URL; a link that does not parse opens nothing.
    onInviteLink: (cb) =>
      events.on("invite-link", ({ url }) => {
        const link = parseInviteLink(url);
        if (link) cb(link);
      }),
    onOAuthCallback: (cb) => events.on("oauth-callback", ({ url }) => cb(url)),
    // ponytail: no native TCP probe yet (Electron region-probe.ts is the model).
    probeRegions: async () => [],
    // No getDisplayMedia in WKWebView: no screen share (a ReplayKit extension later).
    getScreenSources: async () => null,
    selectScreenSource: async () => undefined,
    screenShareAudio: false,
    // TestFlight and the App Store update the app.
    checkForUpdate: async () => ({
      status: "not-available",
      reason: "The App Store updates the iOS app.",
    }),
    closeToTray: null,
    setGlobalShortcuts: async () => null,
    onGlobalShortcut: () => () => undefined,
    haptic: (kind) => {
      call("haptic", { kind }).catch(report("haptic failed"));
    },
    share: (content) =>
      call("share", {
        url: content.url,
        ...(content.text !== undefined ? { text: content.text } : {}),
      }),
    scanQr: () => call("scanQr", {}),
    saveTextFile: (name, text) => call("saveTextFile", { name, text }),
    // APNs. The VAPID key is for Web Push only. The push key's private half stays in the
    // Keychain group of the Notification Service Extension (Hachiman/Push.swift).
    pushSubscribe: async (_vapidPublicKey, deviceId) => {
      const r = await call("push.register", { deviceId });
      return (
        r && {
          kind: "apns",
          token: r.token,
          sandbox: r.sandbox,
          pushKey: r.pushKey,
        }
      );
    },
    setAppearance: ({ theme, background }) => {
      call("setAppearance", { theme, background }).catch(
        report("could not set the appearance"),
      );
    },
    secureStorage: {
      backend: "os-keychain",
      // Native keeps the bytes in the Keychain (Hachiman/WrapKeyStore.swift). This
      // side makes a non-extractable key from them and overwrites its copy, as the
      // Electron renderer does.
      getWrapKey: async (userId) => {
        let b64: string;
        try {
          b64 = await call("wrapKey.get", { userId });
        } catch (e) {
          throw secureStorageError(e);
        }
        const raw = decodeBase64(b64);
        try {
          if (raw === null || raw.length !== 32) {
            throw storageError("StoreCorrupt", "wrap key has a bad length");
          }
          return await crypto.subtle.importKey(
            "raw",
            raw,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          );
        } finally {
          raw?.fill(0);
        }
      },
      clear: async (userId) => {
        try {
          await call("wrapKey.clear", { userId });
        } catch (e) {
          throw secureStorageError(e);
        }
      },
    },
  };
}

function decodeBase64(b64: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof b64 !== "string") return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The rejection shape of ISecureStorage: `name` and `code` are the error code. */
function storageError(
  code: SecureStorageErrorCode,
  message: string,
): Error & { code: SecureStorageErrorCode } {
  const e = Object.assign(new Error(message), { code });
  e.name = code;
  return e;
}

/** A bridge rejection → a SecureStorageErrorCode; a code outside that set means the store is unavailable. */
function secureStorageError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  return storageError(
    secureStorageErrorCode(e) ?? "SecureStorageUnavailable",
    message,
  );
}

export const platformService: IPlatformService = createIosPlatformService(
  nativeCall,
  nativeEvents,
);
