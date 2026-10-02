# @hachiman/hachiman-browser

Browser host for Hachiman, built with Vite. It mounts the shared UI (`@hachiman/hachiman`) and gives it a browser implementation of `IPlatformService`.
The seam contract is [`docs/gateway-protocol.md`](../../docs/gateway-protocol.md) §11. The root [`README.md`](../../README.md) has the system diagrams.

## Where it fits

```mermaid
flowchart LR
  BH["hachiman-browser<br/>main.tsx + PlatformService"]
  UI["@hachiman/hachiman<br/>App"]
  CL["@hachiman/client<br/>HachimanClient"]
  TK["Takusen<br/>OIDC + REST /api/v1"]
  GW["hachiman-gateway<br/>WS /gateway"]
  MED["hachiman-media<br/>WS /voice + WebRTC"]

  BH -- "PlatformProvider" --> UI
  BH -- "same-tab redirect" --> TK
  UI --> CL
  CL --> TK
  CL --> GW
  CL --> MED
```

- The host has no app logic. The shared UI owns the `HachimanClient` and every store.
- The host supplies the OAuth redirect URI, the sign-in redirect, invite deep links and the OAuth callback.
- After sign-in, the UI calls Takusen REST, the gateway and media through `@hachiman/client`.
- `secureStorage` keeps the crypto store wrap key in IndexedDB (see [Crypto store wrap key](#crypto-store-wrap-key)).
- The browser cannot open raw sockets, so `probeRegions` returns `[]`. The browser has its own screen picker, so `getScreenSources` returns `null` and `selectScreenSource` does nothing.

## Code architecture

```mermaid
flowchart TD
  HTML["index.html<br/>root div"]
  MAIN["src/main.tsx<br/>boot + render"]
  PS["src/platforms/browser/PlatformService.ts<br/>platformService, consumeLaunchUrl"]
  KS["src/platforms/browser/secure-storage.ts<br/>createBrowserSecureStorage"]
  IPS["IPlatformService<br/>(@hachiman/hachiman)"]
  APP["App, ThemeProvider, PlatformProvider<br/>(@hachiman/hachiman)"]
  PRE["startPreview<br/>(@hachiman/hachiman/dev/preview)"]

  HTML --> MAIN
  MAIN --> PS
  PS -- "implements" --> IPS
  PS --> KS
  MAIN --> APP
  MAIN -.->|"dev + ?preview"| PRE
```

| File | Contents |
|---|---|
| `index.html` | Page shell. It sets the dark background before the CSS loads and loads `src/main.tsx`. |
| `src/main.tsx` | Reads the launch query and calls `consumeLaunchUrl`. In dev with `?preview`, it starts preview mode. Then it renders `App` in `PlatformProvider` and `ThemeProvider`. |
| `src/platforms/browser/PlatformService.ts` | `platformService` (the `IPlatformService` implementation) and `consumeLaunchUrl`. |
| `src/platforms/browser/secure-storage.ts` | `createBrowserSecureStorage`: the IndexedDB wrap key store. |
| `csp.ts` | `browserCsp`: the Electron CSP rules (`../hachiman-electron/src/main/csp-policy.ts`) as a header and as a meta tag. |
| `vite.config.ts` | React and Tailwind plugins. The `@` alias points to `../hachiman/src`. The dev server uses port 5173 with `strictPort`. `envDir` is the repo root. It sends the CSP and builds module Workers (`worker.format: 'es'`). |
| `*.test.mts`, `src/**/*.test.mts` | CSP and secure storage tests (`node --test`). |
| `tsconfig.json` | Extends `tsconfig.base.json`. It mirrors the `@` alias for the shared UI source. |

### Launch URL routes

`consumeLaunchUrl` reads the page URL once at startup. It handles two routes:

| Route | Action |
|---|---|
| `/oauth/callback?code=…&state=…` (or `error=`) | Sends the full URL to `onOAuthCallback` subscribers. |
| `/invite/<code>` | Sends the code to `onInviteCode` subscribers. |

After a match, it replaces the URL with `/`. A reload then does not use the single-use OAuth code again or open the invite again. Values that arrive before the UI subscribes stay in a buffer.

### OAuth redirect round trip

```mermaid
sequenceDiagram
  participant U as Sign-in UI
  participant TS as TakusenService
  participant PS as platformService
  participant TK as Takusen OIDC
  participant M as main.tsx
  participant App as App

  U->>TS: beginSignIn(oauthRedirectUri, inviteCode)
  TS->>TS: PKCE state + verifier, save pendingFlow
  TS-->>U: authorization URL
  U->>PS: beginOAuth(url)
  PS->>TK: window.location.assign(url)
  TK-->>M: redirect to /oauth/callback?code&state (page reload)
  M->>PS: consumeLaunchUrl()
  PS->>PS: buffer URL, replace URL with /
  App->>PS: onOAuthCallback(cb)
  PS-->>App: callback URL
  App->>TS: completeSignIn(url)
  TS->>TK: POST token endpoint (code, code_verifier)
  TK-->>TS: access_token, refresh_token
```

The redirect reloads the page. `pendingFlow` survives the reload because the Takusen store persists it to `localStorage`. If the sign-in started from an invite, `App` opens the invite dialog after `completeSignIn`.

The redirect URI is `VITE_HACHIMAN_OIDC_REDIRECT` if it is set. Otherwise it is `${window.location.origin}/oauth/callback`. The value must be a redirect URI of the `hachiman-client` OIDC client in `apps/takusen/src/db/seed.ts`.

## Crypto store wrap key

`secureStorage` (contract §11, §12.17) gives the crypto Worker the key that encrypts its IndexedDB store.

- `getWrapKey(userId)` reads the key from the IndexedDB database `hachiman-wrap` (object store `keys`, key `userId`).
- When there is no key, it makes one with `crypto.subtle.generateKey`: AES-GCM 256, not extractable, usages `encrypt` and `decrypt`. It stores the `CryptoKey` object, so the raw bytes never exist in JavaScript.
- The write transaction reads the key again and uses `add`. When two tabs make a key at the same time, both get the stored key.
- A stored value that is not such a key gives `StoreCorrupt`. The host never replaces it.
- Without IndexedDB or WebCrypto (for example, a page that is not a secure context), the call gives `SecureStorageUnavailable`. A user id that is not a lowercase UUID gives `Malformed`.
- `clear(userId)` deletes the key.

Script on the page can use the key. Thus the browser host "trusts the server's code" (§12.17).

## Content-Security-Policy

The browser host sends the same policy as the Electron host (`csp.ts`):

- `worker-src 'self'` for the crypto Worker and the transform Worker.
- `blob:` in `img-src` and `media-src` for decrypted attachments. There is no `blob:` in `script-src` or `worker-src`, and there is no `'wasm-unsafe-eval'`.
- The dev server sends the dev policy as a header. It adds `'unsafe-inline'` scripts for the React Fast Refresh preamble.
- `vite preview` sends the production policy as a header.
- `vite build` puts the production policy in a `<meta http-equiv>` tag in `index.html`. The tag does not have `frame-ancestors`, because browsers ignore it in a meta tag.

Production: the meta tag is not sufficient. A Worker does not get the policy of the page, and the meta tag cannot set `frame-ancestors`. Configure the web server to send `browserCsp(env, { dev: false }).header` as the `Content-Security-Policy` header on all responses, Worker scripts included. Use the same `VITE_*` values as the build.

## Preview mode

In the dev server, `?preview` seeds the stores with a fixture. The UI then renders without Takusen or a gateway. Production builds do not include it. See [`apps/hachiman/src/dev/README.md`](../hachiman/src/dev/README.md) for the URLs and the fixture.

## Run and build

```bash
pnpm dev:browser                              # from the repo root: http://localhost:5173
pnpm build:browser                            # tsgo --noEmit, then vite build
pnpm -F @hachiman/hachiman-browser preview    # serve the build
pnpm -F @hachiman/hachiman-browser typecheck  # tsgo --noEmit
pnpm -F @hachiman/hachiman-browser test       # node --test: CSP and secure storage
pnpm -F @hachiman/hachiman-browser lint
pnpm -F @hachiman/hachiman-browser format
```

The secure storage test needs `fake-indexeddb`. When this package does not have it, the test is skipped.

Keep port 5173. The Takusen CORS allowlist and the seeded OAuth redirect URI use this origin.

## Environment

Vite reads `VITE_*` from the repo-root `.env` at build time. The template is the `# MARK: - Desktop / Web (VITE_*)` section of `.env.example`. Build again after a change.

| Variable | Purpose |
|---|---|
| `VITE_TAKUSEN_OIDC_ISSUER` | OIDC issuer for discovery. |
| `VITE_TAKUSEN_OIDC_CLIENT_ID` | OIDC client ID (`hachiman-client`). |
| `VITE_TAKUSEN_API_BASE` | Takusen API base. The UI adds `/v1` for REST. |
| `VITE_HACHIMAN_GATEWAY_URL` | Gateway WebSocket URL. |
| `VITE_HACHIMAN_OIDC_REDIRECT` | Optional. It overrides the redirect URI. Keep it unset in the shared `.env`, because the Electron host reads it too. |
