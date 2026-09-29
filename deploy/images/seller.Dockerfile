# Seller image. Node 22 is copied from the official bookworm image; logosctl
# 0.2.3 needs trixie glibc, so the final base matches deploy/images/logos.Dockerfile.
FROM node:22-bookworm-slim AS node

FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 65532 --create-home --shell /usr/sbin/nologin ssf

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib /usr/local/lib

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

WORKDIR /app
COPY package.json /app/package.json
COPY dist /app/dist
COPY node_modules /app/node_modules
COPY scripts/start-public.ts /app/scripts/start-public.ts

USER 65532:65532
ENV NODE_ENV=production \
    SSF_ENV_FILE=/etc/ssf/public-testnet.env \
    LOGOSCTL=/opt/logos/squashfs-root/usr/bin/logosctl \
    PATH="/opt/logos/squashfs-root/usr/bin:${PATH}"
ENTRYPOINT ["node", "--experimental-strip-types", "/app/scripts/start-public.ts"]
