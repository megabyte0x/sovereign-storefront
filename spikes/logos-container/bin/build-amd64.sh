#!/bin/sh
# Run on ssf-replica (x86_64). Downloads pinned logosctl 0.2.3 (not rc.1).
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ARCHIVE_SHA256=41c2dffd080c6720c82ed4d0663dd39cbfc1c6aa114434179764732f2ade3096
APPIMAGE_SHA256=63b5d72138f448fa2b95ab7ea2ad6ff7f11486339042771d0b3c79eb4ff27fbb
URL=https://github.com/logos-co/logos-logoscore-cli/releases/download/0.2.3/logosctl-x86_64-linux.tar.gz

mkdir -p state
if [ ! -f state/logosctl.tar.gz ]; then
  curl -fL -o state/logosctl.tar.gz.download "$URL"
  mv state/logosctl.tar.gz.download state/logosctl.tar.gz
fi
echo "${ARCHIVE_SHA256}  state/logosctl.tar.gz" | sha256sum -c -
tar -tzf state/logosctl.tar.gz | grep -qx logosctl-x86_64.AppImage
got_app="$(tar -xOzf state/logosctl.tar.gz | sha256sum | awk '{print $1}')"
if [ "$got_app" != "$APPIMAGE_SHA256" ]; then
  echo "appimage sha mismatch" >&2
  exit 1
fi
echo "appimage_sha256_ok"

docker build \
  --build-arg ARCHIVE_SHA256="$ARCHIVE_SHA256" \
  --build-arg APPIMAGE_NAME=logosctl-x86_64.AppImage \
  --build-arg STORAGE_MODULE_VARIANT=linux-amd64 \
  -t ssf-logosctl:0.2.3-amd64 \
  .
echo "built ssf-logosctl:0.2.3-amd64"
