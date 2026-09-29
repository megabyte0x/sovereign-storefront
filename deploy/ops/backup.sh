#!/bin/sh
# Nightly coordinated backup. `scripts/backup-live.ts export` refuses while the
# seller or the scanner is running, so this stops those two services, exports
# inside a one-off seller container, then starts them again. The archive is
# already encrypted. A cleartext viewing-key shape blocks the off-Pi push.
# The backup key stays on the seller volume and is never rsynced.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="${SSF_COMPOSE_FILE:-$ROOT/deploy/compose.yaml}"
ENV_FILE="${SSF_ENV_FILE:-/srv/ssf/public-testnet.env}"
BACKUP_DIR="${SSF_BACKUP_DIR:-/srv/ssf/backups}"
REPLICA_SSH="${REPLICA_SSH:-ssf-replica}"
REPLICA_DIR="${SSF_REPLICA_BACKUP_DIR:-/srv/ssf/backups}"
KEEP=14
KEY_FILE="${SSF_BACKUP_KEY_FILE:-/var/lib/ssf/backup.key}"
SELLER_DB="${SSF_SELLER_DB:-/var/lib/ssf/seller.sqlite}"
SCANNER_CONFIG="${SSF_SCANNER_CONFIG:-/var/lib/ssf/scanner/scanner.json}"
SCANNER_BIN_HOST="${SSF_SCANNER_BIN_HOST:-/srv/ssf/ops/scanner-bin}"
REPO="${SSF_REPO_ROOT:-$ROOT}"

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

lock_dir() {
  mkdir -p "$1"
  chmod 0700 "$1" 2>/dev/null || sudo chmod 0700 "$1"
}

restart_stack() {
  # One scanner only. Never start a second container with the same viewing key.
  compose up -d scanner
  compose up -d seller
}

refuse_cleartext() {
  node --experimental-strip-types "$ROOT/deploy/ops/backup-guard.ts" --check "$1"
}

run_backup_live() {
  compose run --rm --no-deps --user 0 --entrypoint node \
    -v "$REPO:/src:ro" \
    -v "$SCANNER_BIN_HOST:/usr/local/bin/scanner:ro" \
    -v "$BACKUP_DIR:/backups" \
    seller \
    --experimental-strip-types /src/scripts/backup-live.ts "$@"
}

prune_dir() {
  dir=$1
  # shellcheck disable=SC2012
  ls -1t "$dir"/*.ssbk 2>/dev/null | awk -v keep="$KEEP" 'NR>keep' | while read -r old; do
    rm -f "$old"
  done
  chmod 0700 "$dir" 2>/dev/null || sudo chmod 0700 "$dir"
}

export_archive() {
  lock_dir "$BACKUP_DIR"
  lock_dir "$(dirname "$SCANNER_BIN_HOST")"
  compose cp scanner:/usr/local/bin/scanner "$SCANNER_BIN_HOST" >&2
  chmod 0755 "$SCANNER_BIN_HOST" 2>/dev/null || sudo chmod 0755 "$SCANNER_BIN_HOST"

  compose stop seller >&2
  compose stop scanner >&2
  trap restart_stack EXIT

  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  name="coordinated-${stamp}.ssbk"
  run_backup_live export \
    --repo-root /src \
    --seller-db "$SELLER_DB" \
    --scanner-config "$SCANNER_CONFIG" \
    --scanner-bin /usr/local/bin/scanner \
    --key-file "$KEY_FILE" \
    --out "/backups/$name" >&2
  chmod 0700 "$BACKUP_DIR" 2>/dev/null || sudo chmod 0700 "$BACKUP_DIR"
  chmod 0600 "$BACKUP_DIR/$name" 2>/dev/null || sudo chmod 0600 "$BACKUP_DIR/$name"

  restart_stack >&2
  trap - EXIT
  printf '%s\n' "$BACKUP_DIR/$name"
}

push_one() {
  archive=$1
  case "$archive" in
    *.ssbk) ;;
    *) echo "refusing push: not an encrypted archive" >&2; exit 1 ;;
  esac
  base=$(basename "$archive")
  case "$base" in
    *ufvk*|scanner.json|*.env|backup.key) echo "refusing push: not an archive" >&2; exit 1 ;;
  esac
  refuse_cleartext "$archive"
  tailscale ssh "$REPLICA_SSH" "mkdir -p '$REPLICA_DIR' && chmod 0700 '$REPLICA_DIR'"
  rsync -a -e "tailscale ssh" "$archive" "$REPLICA_SSH:$REPLICA_DIR/$base"
  tailscale ssh "$REPLICA_SSH" "chmod 0700 '$REPLICA_DIR' && chmod 0600 '$REPLICA_DIR/$base'"
  tailscale ssh "$REPLICA_SSH" "ls -1t '$REPLICA_DIR'/*.ssbk 2>/dev/null | awk 'NR>$KEEP' | while read -r old; do rm -f \"\$old\"; done; chmod 0700 '$REPLICA_DIR'"
}

verify_replica() {
  lock_dir "$BACKUP_DIR"
  latest=$(tailscale ssh "$REPLICA_SSH" "ls -1t '$REPLICA_DIR'/*.ssbk | head -n 1")
  case "$latest" in
    *.ssbk) ;;
    *) echo "replica copy missing" >&2; exit 1 ;;
  esac
  scratch="$BACKUP_DIR/replica-verify.ssbk"
  rsync -a -e "tailscale ssh" "$REPLICA_SSH:$latest" "$scratch"
  chmod 0600 "$scratch" 2>/dev/null || sudo chmod 0600 "$scratch"
  chmod 0700 "$BACKUP_DIR" 2>/dev/null || sudo chmod 0700 "$BACKUP_DIR"
  refuse_cleartext "$scratch"
  run_backup_live verify \
    --archive /backups/replica-verify.ssbk \
    --key-file "$KEY_FILE"
  rm -f "$scratch"
}

cmd=${1:-export}
case "$cmd" in
  export)
    archive=$(export_archive)
    push_one "$archive"
    prune_dir "$BACKUP_DIR"
    ;;
  verify)
    verify_replica
    ;;
  *)
    echo "usage: deploy/ops/backup.sh [export|verify]" >&2
    exit 2
    ;;
esac
