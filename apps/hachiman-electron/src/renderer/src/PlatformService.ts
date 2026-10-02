import { oracleService, type IPlatformService } from "@hachiman/hachiman";

// Thin adapter over the preload bridge (src/preload/index.ts). All privileged
// work (URL opening, deep links, raw-socket probing) happens in main.
export const platformService: IPlatformService = {
  platform: "electron",
  insetTitleBar: window.hachiman.insetTitleBar,
  // The system browser can't render `app.hachiman://`, so Oracle's bridge page
  // receives the code and hands it on through that deep link (main/protocol-handler.ts).
  oauthRedirectUri:
    import.meta.env.VITE_HACHIMAN_OIDC_REDIRECT ??
    `${oracleService.env.issuerOrigin}/oauth/electron-bridge`,
  beginOAuth: (url) => {
    window.hachiman
      .openExternal(url)
      .catch((e: unknown) =>
        console.error("[platform] could not open the sign-in page", e),
      );
  },
  onInviteCode: (cb) => window.hachiman.onInviteCode(cb),
  onOAuthCallback: (cb) => window.hachiman.onOAuthCallback(cb),
  probeRegions: (targets) => window.hachiman.probeRegions(targets),
};
