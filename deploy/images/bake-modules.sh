#!/bin/sh
# Unpack storage_module 2.1.2 from the pinned .lgx into /opt/logos-seed.
# Same approach as spikes/logos-container/bake-modules.sh.
set -eu
LGX="${STORAGE_MODULE_LGX:-/tmp/storage_module-2.1.2.lgx}"
LGX_SHA256="${STORAGE_MODULE_LGX_SHA256:-0a5194d6ea5613996d93da2f7d85fdc2cbbec4519e4b2a9781453336470f66c1}"
if [ -n "${STORAGE_MODULE_VARIANT:-}" ]; then
  VARIANT="$STORAGE_MODULE_VARIANT"
elif [ -n "${TARGETARCH:-}" ]; then
  VARIANT="linux-${TARGETARCH}"
else
  VARIANT=linux-arm64
fi
ROOT_HASH="${STORAGE_ROOT_HASH:-19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740}"
SEED=/opt/logos-seed/modules/storage_module
STAGE=/tmp/lgx-unpack

echo "${LGX_SHA256}  ${LGX}" | sha256sum -c -
rm -rf "$STAGE"
mkdir -p "$STAGE" "$SEED"
tar -xzf "$LGX" -C "$STAGE"
test -f "$STAGE/manifest.json"
test -d "$STAGE/variants/${VARIANT}"
cp "$STAGE/manifest.json" "$SEED/"
cp "$STAGE/variants/${VARIANT}/"* "$SEED/"
printf '%s' "$VARIANT" > "$SEED/variant"
grep -q '"version": "2.1.2"' "$SEED/manifest.json"
grep -q "$ROOT_HASH" "$SEED/manifest.json"
test -f "$SEED/storage_module_plugin.so"
case "$VARIANT" in
  linux-arm64) expect_machine=183 ;;
  linux-amd64) expect_machine=62 ;;
  *) echo "bake: unsupported variant $VARIANT" >&2; exit 1 ;;
esac
machine=$(od -An -t u2 -j 18 -N 2 "$SEED/storage_module_plugin.so" | tr -d ' ')
if [ "$machine" != "$expect_machine" ]; then
  echo "bake: $VARIANT plugin e_machine=$machine expected=$expect_machine" >&2
  exit 1
fi
rm -rf "$STAGE" "$LGX"
echo "bake: storage_module 2.1.2 ${VARIANT} present in seed"
