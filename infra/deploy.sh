#!/usr/bin/env bash
# Deploys the latest images to the server. Run it from your machine:
#   DOMAIN=chat.example.com GHCR_TOKEN=<PAT with read:packages> infra/deploy.sh
# HOST defaults to the public IP from `tofu output`. IMAGE_TAG defaults to latest (or set a commit sha).
set -euo pipefail
cd "$(dirname "$0")"

: "${DOMAIN:?set DOMAIN, for example chat.example.com}"
HOST=${HOST:-$(tofu -chdir=oci output -raw public_ip)}
IMAGE_PREFIX=${IMAGE_PREFIX:-ghcr.io/dan-hummelstad/hachiman}
REMOTE="ubuntu@${HOST}"

rsync -az compose.yml Caddyfile bootstrap-env.sh "${REMOTE}:/opt/hachiman/"
ssh "$REMOTE" "cd /opt/hachiman && DOMAIN='${DOMAIN}' PUBLIC_IP='${HOST}' IMAGE_PREFIX='${IMAGE_PREFIX}' ./bootstrap-env.sh"

# The images of a private repository are private packages.
if [ -n "${GHCR_TOKEN:-}" ]; then
  echo "$GHCR_TOKEN" | ssh "$REMOTE" "docker login ghcr.io -u '${GHCR_USER:-dan-hummelstad}' --password-stdin"
fi

ssh "$REMOTE" "cd /opt/hachiman && export IMAGE_TAG='${IMAGE_TAG:-latest}' && docker compose pull --quiet && docker compose up -d --remove-orphans && docker compose ps"
