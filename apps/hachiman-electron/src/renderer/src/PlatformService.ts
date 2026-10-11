import {
  parseInviteLink,
  takusenService,
  type IPlatformService,
} from "@hachiman/hachiman";
import type { SecureStorageFailureCode } from "../../shared/ipc";

// Thin adapter over the preload bridge (src/preload/index.ts). All privileged
// work (URL opening, deep links, raw-socket probing) happens in main.
export const platformService: IPlatformService = {
  platform: "electron",
  insetTitleBar: window.hachiman.insetTitleBar,
  // The system browser can't render `app.hachiman://`, so Takusen's bridge page
  // receives the code and hands it on through that deep link (main/protocol-handler.ts).
  oauthRedirectUri:
    import.meta.env.VITE_HACHIMAN_OIDC_REDIRECT ??
    `${takusenService.env.issuerOrigin}/oauth/electron-bridge`,
  beginOAuth: (url) => {
    window.hachiman
      .openExternal(url)
      .catch((e: unknown) =>
        console.error("[platform] could not open the sign-in page", e),
      );
  },
  // Main sends a checked link; parse it again here, so the seam gets one shape.
  onInviteLink: (cb) =>
    window.hachiman.onInviteLink((raw) => {
      const link = parseInviteLink(raw);
      if (link) cb(link);
    }),
  onOAuthCallback: (cb) => window.hachiman.onOAuthCallback(cb),
  probeRegions: (targets) => window.hachiman.probeRegions(targets),
  getScreenSources: () => window.hachiman.getScreenSources(),
  selectScreenSource: (id, audio) =>
    window.hachiman.selectScreenSource(id, audio),
  screenShareAudio: window.hachiman.screenShareAudio,
  checkForUpdate: () => window.hachiman.checkForUpdate(),
  closeToTray: window.hachiman.closeToTray,
  setGlobalShortcuts: (shortcuts) =>
    window.hachiman.setGlobalShortcuts(shortcuts),
  onGlobalShortcut: (cb) => window.hachiman.onGlobalShortcut(cb),
  haptic: () => undefined,
  // No OS share sheet: the UI offers Copy only.
  share: null,
  // qr-view.tsx scans with BarcodeDetector where Chromium has it.
  scanQr: null,
  setAppearance: () => undefined,
  secureStorage: {
    backend: "os-keychain",
    // Main keeps the bytes under safeStorage (main/secure-storage.ts). The
    // renderer makes a non-extractable key from them and overwrites its copy.
    getWrapKey: async (userId) => {
      const r = await window.hachiman.secureStorage.getWrapKeyBytes(userId);
      if (!r.ok) throw secureStorageError(r.code, r.message);
      const raw = r.value;
      try {
        if (!(raw instanceof Uint8Array) || raw.length !== 32) {
          throw secureStorageError("StoreCorrupt", "wrap key has a bad length");
        }
        return await crypto.subtle.importKey(
          "raw",
          raw,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
      } finally {
        if (raw instanceof Uint8Array) raw.fill(0);
      }
    },
    clear: async (userId) => {
      const r = await window.hachiman.secureStorage.clear(userId);
      if (!r.ok) throw secureStorageError(r.code, r.message);
    },
  },
};

/** The rejection shape of ISecureStorage: `name` and `code` are the error code. */
function secureStorageError(
  code: SecureStorageFailureCode,
  message: string,
): Error & { code: SecureStorageFailureCode } {
  const e = Object.assign(new Error(message), { code });
  e.name = code;
  return e;
}
