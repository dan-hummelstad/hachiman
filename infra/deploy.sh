#!/usr/bin/env bash
# Deploys the images to the server: migrations first, then the stack. The Images workflow runs it
# on each push to main. To run it from your machine:
#   DOMAIN=chat.example.com GHCR_TOKEN=<PAT with read:packages> infra/deploy.sh
# HOST defaults to the public IP from `tofu output`. IMAGE_TAG defaults to latest (or set a commit sha).
# iOS push (optional): APNS_KEY_P8 (the .p8 key, base64), APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC.
set -euo pipefail
cd "$(dirname "$0")"

: "${DOMAIN:?set DOMAIN, for example chat.example.com}"
HOST=${HOST:-$(tofu -chdir=oci output -raw public_ip)}
IMAGE_PREFIX=${IMAGE_PREFIX:-ghcr.io/dan-hummelstad/hachiman}
REMOTE="ubuntu@${HOST}"
# CI sets SSH to a command with its own key and known_hosts file.
SSH=${SSH:-ssh}

rsync -az -e "$SSH" compose.yml Caddyfile bootstrap-env.sh "${REMOTE}:/opt/hachiman/"
# The APNs key goes on stdin, so it is in no command line and no log. Takusen reads it as /keys/apns.p8.
if [ -n "${APNS_KEY_P8:-}" ]; then
  echo "$APNS_KEY_P8" | base64 --decode | $SSH "$REMOTE" "mkdir -p /opt/hachiman/data/keys && umask 077 && cat > /opt/hachiman/data/keys/apns.p8"
fi
APNS_ENV="APNS_KEY_ID='${APNS_KEY_ID:-}' APNS_TEAM_ID='${APNS_TEAM_ID:-}' APNS_TOPIC='${APNS_TOPIC:-}'"
[ -n "${APNS_KEY_P8:-}" ] || APNS_ENV=""
$SSH "$REMOTE" "cd /opt/hachiman && DOMAIN='${DOMAIN}' PUBLIC_IP='${HOST}' IMAGE_PREFIX='${IMAGE_PREFIX}' ${APNS_ENV} ./bootstrap-env.sh"

# The images of a private repository are private packages.
if [ -n "${GHCR_TOKEN:-}" ]; then
  echo "$GHCR_TOKEN" | $SSH "$REMOTE" "docker login ghcr.io -u '${GHCR_USER:-dan-hummelstad}' --password-stdin"
fi

# A failed migration stops the deploy, and the old containers keep running.
$SSH "$REMOTE" "cd /opt/hachiman && export IMAGE_TAG='${IMAGE_TAG:-latest}' && docker compose pull --quiet && docker compose run --rm migrate && docker compose up -d --remove-orphans && docker compose ps"
