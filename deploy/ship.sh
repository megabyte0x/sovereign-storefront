#!/bin/sh
# ship.sh <pi|replica>
# Rsyncs the deploy tree and env example. Never copies deploy/secrets/.
# pi: load locally built arm64 images over tailscale ssh.
# replica: build logos (amd64) and replica-agent on ssf-replica from the rsynced tree.
set -eu
target="${1:-}"
if [ "$target" != "pi" ] && [ "$target" != "replica" ]; then
  echo "usage: deploy/ship.sh <pi|replica>" >&2
  exit 2
fi

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
PI_SSH="${PI_SSH:-home@home}"
REPLICA_SSH="${REPLICA_SSH:-ssf-replica}"

render_config() {
  WSS_HOSTNAME="${WSS_HOSTNAME:-}" node --experimental-strip-types \
    "$ROOT/deploy/cloudflared/render-config.ts" \
    "$ROOT/deploy/cloudflared/config.yml.tmpl" \
    "$ROOT/deploy/cloudflared/config.yml"
}

rsync_tree() {
  host="$1"
  # shellcheck disable=SC2086
  rsync -a --delete -e "tailscale ssh" \
    --exclude 'secrets/' \
    --exclude 'secrets' \
    --exclude '*.env' \
    --exclude 'storage_module-2.1.2.lgx' \
    "$ROOT/deploy/" "$host:/srv/ssf/deploy/"
  rsync -a -e "tailscale ssh" "$ROOT/deploy/env/public-testnet.env.example" "$host:/srv/ssf/deploy/env/public-testnet.env.example"
}

rsync_replica_context() {
  host="$1"
  rsync -a -e "tailscale ssh" \
    "$ROOT/package.json" "$ROOT/package-lock.json" \
    "$host:/srv/ssf/"
  rsync -a -e "tailscale ssh" \
    "$ROOT/node_modules/" "$host:/srv/ssf/node_modules/"
  rsync -a -e "tailscale ssh" \
    "$ROOT/dist/service/" "$host:/srv/ssf/dist/service/"
}

if [ "$target" = "pi" ]; then
  render_config
  rsync_tree "$PI_SSH"
  docker save ssf-seller:arm64 ssf-scanner:arm64 ssf-logos:arm64 \
    | tailscale ssh "$PI_SSH" docker load
  exit 0
fi

rsync_tree "$REPLICA_SSH"
rsync_replica_context "$REPLICA_SSH"
tailscale ssh "$REPLICA_SSH" 'set -eu
  cd /srv/ssf/deploy
  if [ ! -f images/storage_module-2.1.2.lgx ]; then
    echo "stage images/storage_module-2.1.2.lgx on the replica before building logos" >&2
    exit 1
  fi
  docker buildx build --platform linux/amd64 --load \
    -f images/logos.Dockerfile -t ssf-logos:amd64 images
  docker buildx build --platform linux/amd64 --load \
    -f images/replica-agent.Dockerfile -t ssf-replica-agent:amd64 ..
'
