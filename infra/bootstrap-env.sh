#!/usr/bin/env bash
# Runs on the server (deploy.sh calls it) on each deploy. Writes /opt/hachiman/.env with new
# secrets on the first deploy only; later deploys keep its values, so the secrets and keys stay
# the same. Each deploy then adds the settings that a newer release needs (`add_env`), and sets
# the APNs settings when deploy.sh passes them (`set_env`).
# Usage: DOMAIN=chat.example.com PUBLIC_IP=1.2.3.4 IMAGE_PREFIX=ghcr.io/owner/hachiman ./bootstrap-env.sh
# Optional: APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC (deploy.sh has put the key at data/keys/apns.p8).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data/keys data/postgres data/seaweedfs data/caddy backups
# The seaweedfs image runs as uid 1000. Oracle's Ubuntu user is uid 1001, so the folder is not writable without this.
sudo chown 1000:1000 data/seaweedfs

: "${DOMAIN:?}" "${PUBLIC_IP:?}" "${IMAGE_PREFIX:?}"
umask 077

write_env() {
PRIVATE_IP=$(hostname -I | awk '{print $1}')
rand() { openssl rand -hex 32; }
PG_PASSWORD=$(rand)
S3_SECRET=$(rand)

# Without a fixed JWK set, every restart makes all ID tokens invalid (.env.example).
JWKS=$(docker run --rm node:22-alpine node -e '
const { generateKeyPairSync, randomUUID } = require("crypto")
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
console.log(JSON.stringify({ keys: [{ ...privateKey.export({ format: "jwk" }), kid: randomUUID(), alg: "RS256", use: "sig" }] }))')

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
}

if [ -f .env ]; then
  echo ".env exists, keeping its values"
else
  write_env
fi

# A setting that a later release added: written once, never over a value already in .env.
add_env() { grep -q "^$1=" .env || { echo "$1=$2" >>.env && echo "added $1"; }; }
# A setting that deploy.sh owns: replaced on each deploy that passes it.
set_env() {
  sed -i "/^$1=/d" .env
  echo "$1=$2" >>.env
}

# Web Push (contract §4 Push). On the volume: a key inside the container would be new on each
# deploy and orphan every browser subscription.
add_env TAKUSEN_VAPID_KEY /keys/takusen-vapid.p256
# ponytail: one fixed contact; make it a variable when someone else runs a server.
add_env TAKUSEN_VAPID_SUBJECT "mailto:daniel@hummelstad.me"

# APNs (contract §4 Push): only when deploy.sh got the key from CI. Without it, iOS push is off,
# or the lines that someone wrote by hand stay.
if [ -n "${APNS_KEY_ID:-}" ] && [ -f data/keys/apns.p8 ]; then
  : "${APNS_TEAM_ID:?APNS_TEAM_ID is needed with APNS_KEY_ID}"
  set_env TAKUSEN_APNS_KEY /keys/apns.p8
  set_env TAKUSEN_APNS_KEY_ID "${APNS_KEY_ID}"
  set_env TAKUSEN_APNS_TEAM_ID "${APNS_TEAM_ID}"
  set_env TAKUSEN_APNS_TOPIC "${APNS_TOPIC:-app.hachiman.ios}"
  echo "set the APNs settings"
fi
