# Takusen: the Next.js app and the management gRPC process share this image.
# Build from the repo root (the workspace packages @hachiman/client and @hachiman/crypto are TS source):
#   docker build -f apps/takusen/Dockerfile .
# Run the Next app:  pnpm exec next start -H 127.0.0.1
# Run the gRPC side: pnpm start:grpc
# Run migrations:    pnpm db:migrate && pnpm db:seed

FROM node:22-bookworm-slim

RUN corepack enable

WORKDIR /app
COPY . .

# Takusen and its workspace dependencies only. Dev dependencies stay: tsx runs the gRPC process and the db scripts.
# @hachiman/hachiman too: the E2EE canary (src/e2ee) imports its source, and next build typechecks it.
RUN pnpm install --frozen-lockfile --filter "@hachiman/takusen..." --filter "@hachiman/hachiman..."
# next build imports the route modules, and some of them need env at import. The dev values of
# .env.example are placeholders only; the real values come from the env at runtime.
RUN set -a && . ./.env.example && set +a && pnpm -F @hachiman/takusen build

WORKDIR /app/apps/takusen
ENV NODE_ENV=production
EXPOSE 3000

CMD ["pnpm", "exec", "next", "start", "-H", "127.0.0.1"]
