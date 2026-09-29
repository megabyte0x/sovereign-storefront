#!/bin/sh
# Build Pi images on the aarch64 laptop. Replica images are built on ssf-replica
# by ship.sh so nothing is emulated. Does not build replica-agent (3.6 owns that
# Dockerfile). Does not build the delivery image unless SSF_BUILD_DELIVERY=1.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker buildx build --platform linux/arm64 --load \
  -f deploy/images/seller.Dockerfile -t ssf-seller:arm64 .

docker buildx build --platform linux/arm64 --load \
  -f deploy/images/scanner.Dockerfile -t ssf-scanner:arm64 .

LGX_SRC="${SSF_STORAGE_LGX:-spikes/logos-container/state/storage_module-2.1.2.lgx}"
if [ ! -f "$LGX_SRC" ]; then
  echo "logos build needs $LGX_SRC (pinned storage_module 2.1.2 lgx)" >&2
  exit 1
fi
cp "$LGX_SRC" deploy/images/storage_module-2.1.2.lgx
docker buildx build --platform linux/arm64 --load \
  -f deploy/images/logos.Dockerfile -t ssf-logos:arm64 deploy/images
rm -f deploy/images/storage_module-2.1.2.lgx

if [ "${SSF_BUILD_DELIVERY:-}" = "1" ]; then
  docker buildx build --platform linux/arm64 --load \
    -f deploy/images/delivery.Dockerfile -t ssf-delivery:arm64 deploy/images
fi
