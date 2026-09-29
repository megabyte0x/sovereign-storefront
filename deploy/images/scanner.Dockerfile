# Release scanner. Builder is bookworm so the binary's glibc runs on trixie.
FROM rust:1.91-bookworm AS build
WORKDIR /src
COPY services/scanner /src
RUN cargo build --locked --release

FROM debian:trixie-slim
RUN useradd --uid 65532 --create-home --shell /usr/sbin/nologin ssf \
 && mkdir -p /var/lib/ssf/scanner /run/ssf \
 && chown -R 65532:65532 /var/lib/ssf /run/ssf
COPY --from=build /src/target/release/sovereign-storefront-scanner /usr/local/bin/scanner
COPY deploy/images/scanner-entrypoint.sh /usr/local/bin/scanner-entrypoint.sh
RUN chmod 0555 /usr/local/bin/scanner /usr/local/bin/scanner-entrypoint.sh
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/scanner-entrypoint.sh"]
