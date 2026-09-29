# Optional owned delivery node (websocket 8000, cluster 1). D1=a: do not build
# or start this image. Spike 1.3 could not serve light-push/filter on aarch64.
# The compose service is behind the wss profile and is not required for a PASS.
FROM debian:trixie-slim
RUN useradd --uid 65532 --create-home --shell /usr/sbin/nologin ssf
USER 65532:65532
EXPOSE 8000
CMD ["sh", "-c", "echo delivery-node-not-enabled; exit 1"]
