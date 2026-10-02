# Local setup: Takusen sign-in to voice

This guide starts the full stack on one machine: Postgres, Redis, Takusen, the gateway, a media node and a host app.
The wire contract is [`gateway-protocol.md`](gateway-protocol.md).

How sign-in works:

1. The host app does OIDC Authorization Code + PKCE against Takusen with the public client `hachiman-client`.
2. The app sends the access token as a bearer token on REST calls (`/api/v1/*`) and in the gateway `IDENTIFY`.
3. The gateway checks the token with `GET {TAKUSEN_URL}/api/v1/users/@me`. Status 200 means the token is valid. Any other status closes the socket with code 4004.
4. For voice, the gateway signs a short-lived voice token. The media node verifies it with the same Ed25519 key.

The flow uses no token introspection, no per-server OIDC clients and no client secrets.

## 1. Prerequisites

Node 22.9+, pnpm 10+, Go 1.25+, Docker, `openssl`.

```bash
pnpm install
docker compose -f docker/docker-compose.yml up -d   # Postgres :5432 (takusen/takusen), Redis :6379, S3 (SeaweedFS) :8333
```

## 2. Environment

All services read one env file: the repo-root `.env`. Copy the template:

```bash
cp .env.example .env
```

`.env.example` has one `# MARK: -` section for each service. A variable that you set in your shell wins over the file. Next.js also reads `apps/takusen/.env` if it exists, and that file shadows the root file. Move its values to the root `.env`, then delete it.

The Takusen values:

| Var | Value |
| --- | --- |
| `DATABASE_URL` | `postgres://takusen:takusen@localhost:5432/takusen` (default matches the compose file) |
| `REDIS_URL` | `redis://localhost:6379`. Required: the `/api/v1` routes fail without it. |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `OIDC_COOKIES_KEY` | `openssl rand -base64 32` (comma-separate to rotate) |
| `OIDC_ISSUER_URL` | `http://localhost:3000/api/oidc`. It **must** end with `/api/oidc`, because the provider computes every endpoint from it. |
| `TAKUSEN_ALLOWED_ORIGINS` | Optional CORS allowlist (comma-separated). Default: Vite ports 5173/5174 on `localhost` and `127.0.0.1`, and `hachiman://app` (the packaged desktop app). A value replaces the full default list. The list also controls the token and userinfo endpoints. Takusen never allows `Origin: null`. |
| `HACHIMAN_WEB_URL` | Optional. The web app origin that the public `/invite/<code>` page links to. |

## 3. Schema and seed

```bash
pnpm -F @hachiman/takusen db:migrate
pnpm -F @hachiman/takusen db:seed
```

The seed creates the regions and the public PKCE client `hachiman-client` with these redirect URIs:

- `app.hachiman://oauth-callback` (Electron deep link)
- `http://localhost:3000/oauth/electron-bridge` (Takusen page that hands the result to the Electron deep link)
- `http://localhost:5173/oauth/callback`, `http://localhost:5174/oauth/callback` (browser host)

To use other ports, set `HACHIMAN_CLIENT_REDIRECT_URIS` (comma-separated). Then run the seed again.
When the schema changes, drop the dev schema. Then run both commands again.

## 4. Start Takusen

```bash
pnpm dev:takusen                     # Next.js on :3000 and management gRPC on 127.0.0.1:50051
```

Check the issuer:

```bash
curl -s http://localhost:3000/api/oidc/.well-known/openid-configuration | jq '.issuer, .authorization_endpoint'
# "http://localhost:3000/api/oidc"
# "http://localhost:3000/api/oidc/auth"
```

If `authorization_endpoint` has no `/api/oidc` prefix, Takusen did not read the issuer from the env. Stop the dev server fully and start it again.

Create an account at http://localhost:3000/signup.

## 5. Start the gateway and media node

Set `MEDIA_REGION=us-east` in the root `.env`. This is a seeded region code, so guilds that pick a region can land on this node. The gateway and the media node read `DATABASE_URL` and the other values from the same file.

```bash
pnpm dev:server    # gateway ws://localhost:8080/gateway, media ws://localhost:8090/voice
```

Defaults that matter here:

- Gateway `TAKUSEN_URL` is `http://localhost:3000`, and `TAKUSEN_GRPC_ADDR` is `127.0.0.1:50051`.
- Voice key: both processes run in `apps/hachiman-server` and read the seed file from `VOICE_KEY` (default `.dev/keys/voice-signer.ed25519`). The gateway creates the file if it is missing. The media node then reads the same seed. In production, give the media node the public key with `VOICE_PUBKEY` (or `--voice-pubkey`) instead.
- The media node registers with Takusen as `media-<hostname>` in region `MEDIA_REGION` (default `dev`) and sends a heartbeat every 10 s.
- Voice placement: Takusen places a voice channel on the least-loaded live node in the region of the guild. If the guild has no region (the default), Takusen uses any region. Set a guild region only when you run media nodes in several regions.

Other flags: [`apps/hachiman-server/README.md`](../apps/hachiman-server/README.md).

## 6. Start a host app

```bash
pnpm dev:browser    # http://localhost:5173
pnpm dev:electron
```

The shared UI reads these Vite env vars (`apps/hachiman/src/shared/takusen-env.ts`). Vite reads them from the root `.env` (`envDir` is the repo root). The defaults work for local dev. The Electron main process reads the same vars at build time and puts the Takusen and gateway origins into the renderer CSP (`connect-src`):

| Var | Default |
| --- | --- |
| `VITE_TAKUSEN_OIDC_ISSUER` | `http://localhost:3000/api/oidc` |
| `VITE_TAKUSEN_OIDC_CLIENT_ID` | `hachiman-client` |
| `VITE_TAKUSEN_API_BASE` | `<issuer origin>/api`. The REST base is `${apiBase}/v1`. |
| `VITE_HACHIMAN_OIDC_REDIRECT` | Browser: `<page origin>/oauth/callback`. Electron: `<issuer origin>/oauth/electron-bridge`. |
| `VITE_HACHIMAN_GATEWAY_URL` | `ws://localhost:8080/gateway` |

To test audio:

1. Sign in.
2. Create a guild.
3. Set the guild region to the region of the media node.
4. From a second browser profile, join the voice channel of the guild.

## 7. Troubleshooting

| Symptom | Check |
| --- | --- |
| `/.well-known/openid-configuration` returns 404 | `OIDC_ISSUER_URL` does not end with `/api/oidc`. |
| CORS error from the host app to `:3000` | The app origin is not in `TAKUSEN_ALLOWED_ORIGINS`. The packaged desktop app has the origin `hachiman://app`. |
| CSP error in the desktop app console (`connect-src`) | The build of the app used different `VITE_TAKUSEN_*` or `VITE_HACHIMAN_GATEWAY_URL` values. Build the app again with the correct values. |
| Redirect URI rejected on sign-in | The redirect is not in the seeded list. Set `HACHIMAN_CLIENT_REDIRECT_URIS` and run the seed again. |
| Gateway closes with 4004 | `/api/v1/users/@me` rejected the token. Make sure that the gateway `TAKUSEN_URL` points at the Takusen that issued it. |
| REST calls return 500 and mention Redis | `REDIS_URL` is not set, or Redis is not running. |
| Voice join gets no `VOICE_SERVER_UPDATE` | The guild has no region, or no live media node is registered in its region. Examine the `dev:grpc` and gateway logs. |
| Voice WS closes with 4004 | Gateway and media use different voice keys, or the client used the token twice. |

## 8. Production differences

- Use your HTTPS origin in `OIDC_ISSUER_URL`, `VITE_TAKUSEN_OIDC_ISSUER` and the gateway `TAKUSEN_URL`.
- Set `OIDC_JWKS_JSON` to a stored JWK set, so tokens stay valid after a restart.
- Limit `TAKUSEN_ALLOWED_ORIGINS` to your host-app origins. If you ship the desktop app, the list must include `hachiman://app`. Example: `TAKUSEN_ALLOWED_ORIGINS=https://hachiman.example.com,hachiman://app`.
- Build the desktop app with the production `VITE_TAKUSEN_OIDC_ISSUER` and `VITE_HACHIMAN_GATEWAY_URL` (`wss://`). These values set the CSP of the app.
- Give media nodes `VOICE_PUBKEY` or `--voice-pubkey` (the public key of the gateway), not the seed file.
- The management gRPC has no auth yet. Keep it on loopback or a private network (`TAKUSEN_GRPC_BIND_ADDR`).
