FROM debian:trixie-slim
# bookworm-slim cannot run extracted logosctl 0.2.3 (GLIBC_2.38, GLIBC_2.39, GLIBCXX_3.4.32).
# Pi is Debian 13 trixie (glibc 2.41). Do not switch this base back to bookworm.

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 65532 --create-home --shell /usr/sbin/nologin ssf

ARG TARGETARCH
ARG STORAGE_MODULE_VERSION=2.1.2
ARG STORAGE_ROOT_HASH=19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740
ARG STORAGE_MODULE_LGX_SHA256=0a5194d6ea5613996d93da2f7d85fdc2cbbec4519e4b2a9781453336470f66c1
ARG ARM64_ARCHIVE_SHA256=f1ed1debcac20a9943ae2786021f574e439af42f853db0e753a365acb45eb3c3
ARG AMD64_ARCHIVE_SHA256=41c2dffd080c6720c82ed4d0663dd39cbfc1c6aa114434179764732f2ade3096

RUN set -eu; \
  if [ "$TARGETARCH" = "arm64" ]; then \
    url=https://github.com/logos-co/logos-logoscore-cli/releases/download/0.2.3/logosctl-aarch64-linux.tar.gz; \
    sum="$ARM64_ARCHIVE_SHA256"; \
    app=logosctl-aarch64.AppImage; \
  elif [ "$TARGETARCH" = "amd64" ]; then \
    url=https://github.com/logos-co/logos-logoscore-cli/releases/download/0.2.3/logosctl-x86_64-linux.tar.gz; \
    sum="$AMD64_ARCHIVE_SHA256"; \
    app=logosctl-x86_64.AppImage; \
  else \
    echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1; \
  fi; \
  curl -fsSL -o /tmp/logosctl.tar.gz "$url"; \
  echo "$sum  /tmp/logosctl.tar.gz" | sha256sum -c -; \
  mkdir -p /opt/logos; \
  tar -xzf /tmp/logosctl.tar.gz -C /tmp; \
  chmod +x "/tmp/$app"; \
  cd /opt/logos; \
  "/tmp/$app" --appimage-extract; \
  test -x /opt/logos/squashfs-root/usr/bin/logosctl; \
  rm -f /tmp/logosctl.tar.gz "/tmp/$app"

ENV PATH="/opt/logos/squashfs-root/usr/bin:${PATH}" \
    XKB_CONFIG_ROOT="/opt/logos/squashfs-root/usr/share/X11/xkb" \
    QT_QPA_PLATFORM=offscreen \
    LOGOSCTL=/opt/logos/squashfs-root/usr/bin/logosctl

COPY bake-modules.sh /tmp/bake-modules.sh
COPY storage_module-2.1.2.lgx /tmp/storage_module-2.1.2.lgx
RUN chmod +x /tmp/bake-modules.sh \
 && STORAGE_ROOT_HASH="${STORAGE_ROOT_HASH}" \
    STORAGE_MODULE_VARIANT="linux-${TARGETARCH}" \
    STORAGE_MODULE_LGX_SHA256="${STORAGE_MODULE_LGX_SHA256}" \
    /tmp/bake-modules.sh \
 && rm -f /tmp/bake-modules.sh \
 && chown -R 65532:65532 /opt/logos /opt/logos-seed

COPY logos-entrypoint.sh /usr/local/bin/logos-entrypoint.sh
RUN chmod 0555 /usr/local/bin/logos-entrypoint.sh

VOLUME /data
WORKDIR /data
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/logos-entrypoint.sh"]
