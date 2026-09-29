FROM debian:trixie-slim
# bookworm-slim cannot run extracted logosctl 0.2.3 (GLIBC_2.38, GLIBC_2.39, GLIBCXX_3.4.32).
# Pi is Debian 13 trixie (glibc 2.41). Do not switch this base back to bookworm.

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

ARG ARCHIVE_SHA256=f1ed1debcac20a9943ae2786021f574e439af42f853db0e753a365acb45eb3c3
ARG APPIMAGE_NAME=logosctl-aarch64.AppImage
ARG STORAGE_MODULE_VERSION=2.1.2
ARG STORAGE_ROOT_HASH=19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740
ARG TARGETARCH
ARG STORAGE_MODULE_VARIANT
ARG STORAGE_MODULE_LGX_SHA256=0a5194d6ea5613996d93da2f7d85fdc2cbbec4519e4b2a9781453336470f66c1
COPY state/logosctl.tar.gz /tmp/logosctl.tar.gz
RUN echo "${ARCHIVE_SHA256}  /tmp/logosctl.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/logos \
 && tar -xzf /tmp/logosctl.tar.gz -C /tmp \
 && chmod +x "/tmp/${APPIMAGE_NAME}" \
 && cd /opt/logos \
 && "/tmp/${APPIMAGE_NAME}" --appimage-extract \
 && test -x /opt/logos/squashfs-root/usr/bin/logosctl \
 && rm -f /tmp/logosctl.tar.gz "/tmp/${APPIMAGE_NAME}"

ENV PATH="/opt/logos/squashfs-root/usr/bin:${PATH}" \
    XKB_CONFIG_ROOT="/opt/logos/squashfs-root/usr/share/X11/xkb" \
    QT_QPA_PLATFORM=offscreen \
    LOGOSCTL=/opt/logos/squashfs-root/usr/bin/logosctl

COPY bake-modules.sh /tmp/bake-modules.sh
COPY state/storage_module-2.1.2.lgx /tmp/storage_module-2.1.2.lgx
RUN chmod +x /tmp/bake-modules.sh \
 && STORAGE_ROOT_HASH="${STORAGE_ROOT_HASH}" \
    STORAGE_MODULE_VARIANT="${STORAGE_MODULE_VARIANT:-linux-${TARGETARCH}}" \
    STORAGE_MODULE_LGX_SHA256="${STORAGE_MODULE_LGX_SHA256}" \
    /tmp/bake-modules.sh \
 && rm -f /tmp/bake-modules.sh

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

VOLUME /data
WORKDIR /data
# Thin wrapper copies baked storage_module into /data then execs extracted logosctl.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["daemon", "start"]
