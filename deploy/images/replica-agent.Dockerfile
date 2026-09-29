# Replica agent for ssf-replica (linux/amd64). Final base is debian:trixie-slim.
# Do not switch this base to bookworm (D6). Node 22 is copied from the official
# image; that image's glibc is older than trixie, so the binary runs here.
# This image does not start storage_module. The logos image must call init
# before start. The agent only dials the already-started node via logosctl.
# Build context is the repository root:
#   docker build -f deploy/images/replica-agent.Dockerfile .

FROM node:22-bookworm-slim AS node

FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 65532 --home-dir /nonexistent --shell /usr/sbin/nologin ssf

ARG TARGETARCH
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
  rm -f /tmp/logosctl.tar.gz "/tmp/$app"; \
  chmod -R a+rX /opt/logos

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib /usr/local/lib

ENV LOGOSCTL=/opt/logos/squashfs-root/usr/bin/logosctl \
    PATH="/opt/logos/squashfs-root/usr/bin:${PATH}"

WORKDIR /app
COPY package.json package-lock.json ./
COPY node_modules ./node_modules
COPY dist/service ./dist/service

USER 65532:65532
ENV NODE_ENV=production \
    SSF_REPLICA_PORT=8790
EXPOSE 8790
ENTRYPOINT ["node", "dist/service/replica-agent/main.js"]
