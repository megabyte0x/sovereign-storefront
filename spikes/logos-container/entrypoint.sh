#!/bin/sh
set -eu
LOGOSCTL="${LOGOSCTL:-/opt/logos/squashfs-root/usr/bin/logosctl}"
DATA="${LOGOS_CONFIG_DIR:-/data}"
SEED=/opt/logos-seed

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

exec "$LOGOSCTL" --config-dir "$DATA" "$@"
