#!/usr/bin/env bash
# Runs on the server (deploy.sh calls it). Writes /opt/hachiman/.env with new secrets on the
# first deploy only. Later deploys keep the file, so the secrets and keys stay the same.
# Usage: DOMAIN=chat.example.com PUBLIC_IP=1.2.3.4 IMAGE_PREFIX=ghcr.io/owner/hachiman ./bootstrap-env.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data/keys data/postgres data/seaweedfs data/caddy backups
# The seaweedfs image runs as uid 1000. Oracle's Ubuntu user is uid 1001, so the folder is not writable without this.
sudo chown 1000:1000 data/seaweedfs

if [ -f .env ]; then
  echo ".env exists, keeping it"
  exit 0
fi

: "${DOMAIN:?}" "${PUBLIC_IP:?}" "${IMAGE_PREFIX:?}"
PRIVATE_IP=$(hostname -I | awk '{print $1}')
rand() { openssl rand -hex 32; }
PG_PASSWORD=$(rand)
S3_SECRET=$(rand)

# Without a fixed JWK set, every restart makes all ID tokens invalid (.env.example).
JWKS=$(docker run --rm node:22-alpine node -e '
const { generateKeyPairSync, randomUUID } = require("crypto")
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
console.log(JSON.stringify({ keys: [{ ...privateKey.export({ format: "jwk" }), kid: randomUUID(), alg: "RS256", use: "sig" }] }))')

umask 077
cat > .env <<EOF
# Written by bootstrap-env.sh. The secrets are not stored anywhere else: back up this file.
# Unset tunables use the code defaults (.env.example).
DOMAIN=${DOMAIN}
PUBLIC_IP=${PUBLIC_IP}
PRIVATE_IP=${PRIVATE_IP}
IMAGE_PREFIX=${IMAGE_PREFIX}

POSTGRES_PASSWORD=${PG_PASSWORD}
DATABASE_URL=postgres://takusen:${PG_PASSWORD}@127.0.0.1:5432/takusen
REDIS_URL=redis://127.0.0.1:6379
TAKUSEN_GRPC_ADDR=127.0.0.1:50051
VOICE_KEY=/keys/voice-signer.ed25519

S3_ENDPOINT=http://127.0.0.1:8333
S3_REGION=us-east-1
S3_BUCKET=hachiman-uploads
S3_ACCESS_KEY_ID=hachiman
S3_SECRET_ACCESS_KEY=${S3_SECRET}
S3_FORCE_PATH_STYLE=true

AUTH_SECRET=$(openssl rand -base64 32)
AUTH_TRUST_HOST=true
NEXTAUTH_URL=https://${DOMAIN}
OIDC_ISSUER_URL=https://${DOMAIN}/api/oidc
OIDC_COOKIES_KEY=$(openssl rand -base64 32)
OIDC_JWKS_JSON='${JWKS}'
TAKUSEN_ALLOWED_ORIGINS=https://app.${DOMAIN},hachiman://app
HACHIMAN_WEB_URL=https://app.${DOMAIN}
HACHIMAN_CLIENT_REDIRECT_URIS=app.hachiman://oauth-callback,https://${DOMAIN}/oauth/electron-bridge,https://app.${DOMAIN}/oauth/callback
TAKUSEN_DS_SIGNING_KEY=/keys/takusen-ds.ed25519
TAKUSEN_KT_SIGNING_KEY=/keys/takusen-kt.ed25519

GATEWAY_LISTEN_ADDR=127.0.0.1:8080
TAKUSEN_URL=http://127.0.0.1:3000
TURN_SECRET=$(rand)
TURN_URLS=turn:${DOMAIN}:3478?transport=udp,turn:${DOMAIN}:3478?transport=tcp

MEDIA_NODE_ID=media-1
# ponytail: nearest seeded region (Singapore). Add a Sydney region to apps/takusen/src/db/seed.ts when placement needs it.
MEDIA_REGION=ap-southeast
EOF
echo "wrote .env"
