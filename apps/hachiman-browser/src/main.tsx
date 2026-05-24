import "@hachiman/hachiman/style.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  App,
  ThemeProvider,
  PlatformProvider,
  oracleService,
  type IMumbleServiceFactory,
  type IPlatformService,
  type MumbleConnectOptions,
} from "@hachiman/hachiman";
import { MumbleService } from "./platforms/browser/MumbleService";
import { PlatformService } from "./platforms/browser/PlatformService";

const mumbleFactory: IMumbleServiceFactory = async (
  opts: MumbleConnectOptions,
) => {
  return new MumbleService(opts.serverUrl, opts.port, opts.username, {
    oracleToken: opts.oracleToken,
  });
};

const platform: IPlatformService = new PlatformService();

// takusen://join… browser fallback: the Oracle landing page emits
//   <a href="/join#<base64url-signed-payload>">Open in browser</a>
// so users without the Electron app can still join. The hash never reaches
// the server. The shared App's `useTakusenJoinUri` hook reads
// `window.location.pathname === '/join'` plus the hash and pops the
// JoinServerModal automatically.
if (
  window.location.hash.length > 1 &&
  window.location.pathname.replace(/\/+$/, "") !== "/join"
) {
  // Hash-only `#<base64url>` on the root path is most likely a fallback-routed
  // deep link. Don't touch hashes that look like ordinary fragments.
  const h = window.location.hash.slice(1);
  if (/^[A-Za-z0-9_-]{16,}$/.test(h) && window.location.pathname === "/") {
    window.history.replaceState(null, "", `/join#${h}`);
  }
}

// Handle the OAuth callback when the OIDC provider redirects back to
// /oauth/callback?code=...&state=... — we exchange synchronously then strip
// the query so a reload doesn't try to redeem the code twice.
;(async () => {
  if (window.location.pathname !== "/oauth/callback") return;
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return;
  try {
    await oracleService.completeSignIn({ code, state });
  } catch (e) {
    console.error("[oauth] callback failed", e);
  } finally {
    window.history.replaceState({}, "", "/");
  }
})();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlatformProvider value={{ mumble: mumbleFactory, platform }}>
      <ThemeProvider defaultTheme="system" storageKey="hachiman-ui-theme">
        <App />
      </ThemeProvider>
    </PlatformProvider>
  </StrictMode>,
);
