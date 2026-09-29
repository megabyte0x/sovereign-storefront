#!/bin/sh
# Seed the baked storage_module, call storage init before start, then run the daemon.
set -eu
LOGOSCTL="${LOGOSCTL:-/opt/logos/squashfs-root/usr/bin/logosctl}"
DATA="${LOGOS_CONFIG_DIR:-/data}"
SEED=/opt/logos-seed
LISTEN="${LOGOS_LISTEN_PORT:-8091}"
DISC="${LOGOS_DISC_PORT:-8090}"

mkdir -p "$DATA"
if [ ! -d "$DATA/modules/storage_module" ] && [ -d "$SEED/modules/storage_module" ]; then
  cp -a "$SEED/modules" "$DATA/"
fi
if [ -d "$SEED/data" ] && [ ! -d "$DATA/data/package_manager" ]; then
  mkdir -p "$DATA/data"
  cp -a "$SEED/data/." "$DATA/data/"
fi

export PATH="/opt/logos/squashfs-root/usr/bin:${PATH:-}"
if [ -d /opt/logos/squashfs-root/usr/share/X11/xkb ]; then
  export XKB_CONFIG_ROOT="/opt/logos/squashfs-root/usr/share/X11/xkb"
fi
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-offscreen}"

INIT="$DATA/storage-init.json"
if [ ! -f "$INIT" ]; then
  printf '%s\n' \
    "{\"data-dir\":\"$DATA/storage-data\",\"log-level\":\"INFO\",\"listen-port\":$LISTEN,\"disc-port\":$DISC,\"network\":\"logos.test\"}" \
    > "$INIT"
fi
# A storage log file hits EBADF after a few minutes in these containers, and the
# resulting write-error storm crashes storage_module. Log to stdout instead, and
# strip the key from init files that older images wrote.
sed -i 's/"log-file":"[^"]*",//' "$INIT"

"$LOGOSCTL" --config-dir "$DATA" daemon start --detach
ready=0
i=0
while [ "$i" -lt 30 ]; do
  if "$LOGOSCTL" --config-dir "$DATA" --json daemon status 2>/dev/null | grep -q '"status":"running"'; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "logos: daemon did not start" >&2
  exit 1
fi

debug=$("$LOGOSCTL" --config-dir "$DATA" --json call storage_module debug 2>/dev/null || true)
if ! printf '%s' "$debug" | grep -q '"id"'; then
  "$LOGOSCTL" --config-dir "$DATA" module load storage_module || true
  "$LOGOSCTL" --config-dir "$DATA" --json call storage_module init "@$INIT"
fi
"$LOGOSCTL" --config-dir "$DATA" --json call storage_module start

# Detach already backgrounded the daemon. Supervise it as PID 1.
while "$LOGOSCTL" --config-dir "$DATA" --json daemon status 2>/dev/null | grep -q '"status":"running"'; do
  sleep 5
done
echo "logos: daemon exited" >&2
exit 1
