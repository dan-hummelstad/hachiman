// IPC channel names shared by main (index.ts, protocol-handler.ts) and the preload.
// Constants only: electron-vite inlines this module into each bundle, so the
// sandboxed preload never loads a main-process module at runtime.

/** main → renderer: `takusen://invite/<code>` deep link; payload is the code. */
export const INVITE_CODE_CHANNEL = "hachiman:invite-code";
/** main → renderer: `app.hachiman://oauth-callback?…`; payload is the raw URL. */
export const OAUTH_CALLBACK_CHANNEL = "hachiman:oauth-callback";
/** renderer → main (invoke): open an http(s) URL in the system browser. */
export const OPEN_EXTERNAL_CHANNEL = "hachiman:open-external";
/** renderer → main (invoke): TCP-connect RTT probe of region endpoints. */
export const PROBE_REGIONS_CHANNEL = "hachiman:probe-regions";
