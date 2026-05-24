# Oracle/Takusen SSO — setup from scratch

End-to-end checklist to stand up Oracle (the identity provider + server registry), a Mumble server that trusts it, and a Hachiman host app signed into both.

The wire model: a host app does PKCE against Oracle, drops the resulting access token into `Authenticate.oracle_token`, and the Mumble server validates it via RFC 7662 introspection. Three secrets need to line up.

---

## 0. Prerequisites

- Node 20+, pnpm 10+
- Go 1.22+ (server)
- Postgres 14+ running locally (Oracle's data store)
- `openssl` (for generating signing keys)
- `sqlite3` CLI (for poking the Mumble server's config table)

```bash
pnpm install
```

---

## 1. Postgres database for Oracle

Anything that can serve `postgres://oracle:oracle@localhost:5432/oracle` works. With a stock local install:

```bash
createuser -s oracle               # or: psql -c "CREATE ROLE oracle LOGIN SUPERUSER PASSWORD 'oracle';"
createdb -O oracle oracle
```

If you change the URL, mirror it in `apps/oracle/.env` (next step).

---

## 2. Oracle environment

```bash
cp apps/oracle/.env.example apps/oracle/.env
```

Then fill the three secrets — each value is an independent `openssl rand -base64 32`:

| Var | Purpose |
| --- | --- |
| `AUTH_SECRET` | Signs Auth.js session JWTs/CSRF. |
| `OIDC_COOKIES_KEY` | Signs panva oidc-provider's interaction cookies. Comma-separate to rotate. |
| `TAKUSEN_INVITE_SIGNING_KEY` | HMACs `takusen://join#…` invite payloads so clients can verify offline. ≥ 32 chars. |

Leave `OIDC_ISSUER_URL=http://localhost:3000/api/oidc` for local dev. **It must end with `/api/oidc`** — panva computes every endpoint URL relative to it, and the catch-all route is mounted at `/api/oidc/[...path]`.

Production: also set `OIDC_JWKS_JSON` to a stable JWK set so ID tokens survive restarts. Optionally set `TAKUSEN_ALLOWED_ORIGINS` (comma-separated) to whitelist your host-app origins for the `/api/*` CORS middleware (defaults: `http://localhost:5173`, `http://localhost:5174`, plus their `127.0.0.1` variants).

---

## 3. Schema + seed

```bash
pnpm -F @hachiman/oracle db:migrate   # applies apps/oracle/drizzle/*.sql
pnpm -F @hachiman/oracle db:seed      # idempotent — inserts the public `hachiman-client` OIDC client
```

The seed registers the desktop+browser PKCE client with redirect URIs `app.hachiman://oauth-callback`, `http://localhost:5173/oauth/callback`, and `http://localhost:5174/oauth/callback`. Override via `HACHIMAN_CLIENT_REDIRECT_URIS=...` if you run on different ports.

> Schema still in flux? Per repo convention, drop the DB and regen the seed migration (`pnpm -F @hachiman/oracle db:generate`) rather than stacking ALTERs.

---

## 4. Start Oracle

```bash
pnpm -F @hachiman/oracle dev
```

Smoke-check the issuer:

```bash
curl -s http://localhost:3000/api/oidc/.well-known/openid-configuration | jq '.issuer, .authorization_endpoint, .introspection_endpoint'
```

You want to see:

```
"http://localhost:3000/api/oidc"
"http://localhost:3000/api/oidc/auth"
"http://localhost:3000/api/oidc/token/introspection"
```

If `authorization_endpoint` is `http://localhost:3000/auth`, your issuer env wasn't picked up — fully stop the dev server (not just HMR) and restart.

---

## 5. Register your Mumble server in Oracle

Sign into Oracle (`http://localhost:3000`) and create a server in the dashboard. Then mint its confidential introspection credentials — the secret is returned **once**, so copy it now:

```bash
# Get the server id from the dashboard URL, then:
SID=<server-uuid>
curl -X POST http://localhost:3000/api/servers/$SID/oidc \
  -H "cookie: <your authjs.session-token cookie>" \
  | jq
# → { "client": { "clientId": "mumble-<short>", ... }, "secret": "<plaintext, save it now>" }
```

The dashboard exposes the same action; the API form above is just easier to script. Anything other than the first response loses the plaintext secret — regenerate to mint a new one.

---

## 6. Tell the Mumble server about Oracle

Grumble persists per-virtual-server config in `apps/hachiman-server/bin/data/murmur.sqlite` (table `config`, `server_id=0` for the default virtual server). There's no admin CLI yet, so write directly:

```bash
sqlite3 apps/hachiman-server/bin/data/murmur.sqlite <<SQL
INSERT OR REPLACE INTO config (server_id, key, value) VALUES
  (0, 'OracleIntrospectionURL', 'http://localhost:3000/api/oidc/token/introspection'),
  (0, 'OracleClientID',         '<clientId from step 5>'),
  (0, 'OracleClientSecret',     '<secret from step 5>'),
  (0, 'OracleOnly',             'false');
SQL
```

All three of URL / ClientID / ClientSecret must be set or the server treats Oracle as disabled and silently drops inbound tokens.

`OracleOnly=true` rejects any client that doesn't present a verifiable Oracle token. Match it to the `servers.oracle_only` flag in Oracle's dashboard — Oracle uses its copy to render the "Oracle-only server" badge; the Mumble server uses its copy to actually enforce.

If the DB doesn't exist yet, run `pnpm dev:server` once first to let Grumble bootstrap it, then re-run the SQL.

---

## 7. Start the Mumble server

```bash
pnpm dev:server
```

Restarts pick up the new config rows automatically (read on every authenticate, no caching).

---

## 8. Start a host app

```bash
pnpm dev:electron     # OR
pnpm dev:browser
```

In the app: open the user menu → "Sign in to Oracle" → complete the PKCE flow in your browser → control returns via `app.hachiman://oauth-callback` (Electron) or `/oauth/callback` (browser). Connect to the Mumble server — Grumble runs introspection during Authenticate, and remote users show the Oracle handle plus a verified badge in the member list.

---

## 9. Verifying the round-trip

| Symptom | Where to look |
| --- | --- |
| `/.well-known/openid-configuration` returns 404 | Issuer URL missing `/api/oidc` — see step 2. |
| `authorize` 404s on `http://localhost:3000/auth` (no `/api/oidc` prefix in `authorization_endpoint`) | `routes` not configured on the panva Provider — they default to `/auth`, `/token`, etc. and ignore the issuer's path. See `apps/oracle/src/lib/oidc-provider.ts` (`routes:` block) and the matching prefix-passthrough in `apps/oracle/src/app/api/oidc/[...path]/route.ts`. |
| CORS error from host app to `:3000` | Origin not in `TAKUSEN_ALLOWED_ORIGINS`; CSP doesn't list `http://localhost:3000` in `connect-src`. |
| Server logs `"sent oracle_token but server has no introspection configured"` | Step 6 incomplete on that virtual server. |
| Server logs `"introspection audience mismatch"` | The Mumble server's `OracleClientID` doesn't match the `client_id` the token was issued to — re-check step 5/6. |
| Connect rejected with `AuthenticatorFail` and Oracle-only is on | Sign in to Oracle first, then reconnect. |

---

## 10. Production deltas

- Replace `http://localhost:3000` with your real HTTPS issuer everywhere (`OIDC_ISSUER_URL`, host-app `VITE_TAKUSEN_OIDC_ISSUER`, the Mumble server's `OracleIntrospectionURL`).
- Set `OIDC_JWKS_JSON` to a persisted JWK set.
- Tighten `TAKUSEN_ALLOWED_ORIGINS` to just your host-app origins.
- Keep `OracleClientSecret` out of source control — it lives in the Mumble server's SQLite, not in `.env`, so back that file up alongside the database.
