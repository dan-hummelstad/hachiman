# The web app as static files inside Caddy. Caddy is also the TLS reverse proxy of the deploy
# (infra/Caddyfile). Vite bakes the endpoints in at build time, so DOMAIN is a build arg:
#   docker build -f apps/hachiman-browser/Dockerfile --build-arg DOMAIN=chat.example.com .

FROM node:22-bookworm-slim AS build
ARG DOMAIN
ENV VITE_TAKUSEN_OIDC_ISSUER=https://${DOMAIN}/api/oidc \
    VITE_HACHIMAN_GATEWAY_URL=wss://${DOMAIN}/gateway

RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@hachiman/hachiman-browser..."
RUN pnpm -F @hachiman/hachiman-browser exec vite build

# The built index.html has the policy only as a meta tag. Workers need the header (vite.config.ts).
RUN cd apps/hachiman-browser && node --experimental-strip-types --input-type=module -e \
  "import { browserCsp } from './csp.ts'; console.log('header Content-Security-Policy \"' + browserCsp(process.env, { dev: false }).header + '\"')" \
  > /csp.caddy

FROM caddy:2
COPY --from=build /app/apps/hachiman-browser/dist /srv/app
COPY --from=build /csp.caddy /etc/caddy/csp.caddy
