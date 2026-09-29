# Public testnet deploy kit

Pi (`linux/arm64`) runs seller, scanner, logos-a and cloudflared. Replica B and the replica agent run on `ssf-replica` (`linux/amd64`). D1=a: no owned delivery node. `WSS_HOSTNAME` and `SSF_WSS_ORIGIN` stay empty, and the `delivery` service is behind the `wss` profile.

## Layout

- `compose.yaml` is the Pi stack. `8091` publishes only on `PI_TAILNET_IP`. Admin publishes only as `127.0.0.1:8788`. Buyer port 8787 stays on the Compose network. The seller mounts `scanner-state` at `/var/lib/ssf/scanner` and `logos-a-data` at `/data`, and the image contains `logosctl`.
- `compose.replica.yaml` is logos-b plus `replica-agent`. The process binds `0.0.0.0:8790` inside the container. Compose publishes only `${REPLICA_TAILNET_IP}:8790:8790`. The agent image contains the same logosctl extract as the logos image. `logos-b` and `replica-agent` share `logos-b-ipc` at `/tmp` so the agent's logosctl can dial the daemon sockets.
- `cloudflared/config.yml.tmpl` routes `store.agentmascot.app` to `http://seller:8787`. The `wss.` rule is included only when `WSS_HOSTNAME` is non-empty. There is no ingress for 8788. The last rule is `http_status:404`.
- Tunnel credentials live in `deploy/secrets/` (0600, gitignored) and are mounted read-only into cloudflared only.
- Logos uses `debian:trixie-slim`, `--appimage-extract`, and a baked `storage_module`. The entrypoint calls storage `init` before `start`.

## Build and ship

On the aarch64 laptop, with dependencies installed and `spikes/logos-container/state/storage_module-2.1.2.lgx` present, create build provenance before building the seller image:

```sh
npm run build:clean
deploy/build-images.sh
```

`build:clean` writes `dist/build-info.json` alongside the compiled service; the seller image copies that file into `/app/dist/` for the public deployment-evidence preflight. `build-images.sh` builds seller, scanner and logos with `docker buildx build --platform linux/arm64 --load`; it does not compile the app or create build provenance.

```sh
deploy/ship.sh pi
deploy/ship.sh replica
```

`ship.sh` rsyncs the deploy tree and the env example with `rsync -e "tailscale ssh"`. It never copies `deploy/secrets/`. The replica ship also rsyncs `package.json`, `package-lock.json`, production `node_modules`, and `dist/service` so the agent image build context is on the host. Replica images (`ssf-logos:amd64` and `ssf-replica-agent`) are built on `ssf-replica`, not emulated.

Copy `deploy/env/public-testnet.env.example` to `/srv/ssf/public-testnet.env` (0600) and set `PI_TAILNET_IP` and `REPLICA_TAILNET_IP` to `tailscale ip -4`. Compose injects `SSF_REPLICA_AGENT_URL` and `SSF_LOGOS_ADVERTISE_HOST`; do not put those `${…}` literals in seller keys. Place the replica bearer token at `/srv/ssf/replica.token` (0600) on the replica host and at `SSF_REPLICA_TOKEN_FILE` on the Pi. Do not put the admin token or UFVK in the env file. The scanner UFVK stays in `scanner.json` (0600).

`scanner.json` `lightwalletd` must be `https://testnet.zec.rocks:443` (`Network::TestNetwork`). Compose cannot enforce host egress; the host firewall should allow the scanner container only that endpoint.

## Start order

Replica first: `docker compose -f deploy/compose.replica.yaml --env-file /srv/ssf/public-testnet.env up -d`.

Then the Pi: `docker compose -f deploy/compose.yaml --env-file /srv/ssf/public-testnet.env up -d`.

Named volumes are created root-owned. Before the first start, chown them to `65532:65532` with a one-off `docker run --user 0`. Compose services themselves stay non-root.

The seller container entrypoint is `scripts/start-public.ts`. It reads `SSF_ENV_FILE` (default `/etc/ssf/public-testnet.env`) and execs `dist/service/main.js`. It does not print env values.

Docker publishes `127.0.0.1:8788` on the host to container port 8788. The process must listen on `0.0.0.0` inside the container or the proxy cannot connect. Other containers on the Compose network can still open `seller:8788`; cloudflared has no ingress for it, and the route still requires the admin token.

## Doctor

```sh
node --experimental-strip-types scripts/public-doctor.ts --strict
```

Rows: `tls`, `seller-public`, `admin-not-public`, `html-integrity`, `scanner` (tip within 3 blocks of lightwalletd), `logos-a`, `logos-b-replica`, `embed-js`, `backup-age`. `delivery-wss` is omitted unless `SSF_WSS_ORIGIN` is set, so `--strict` does not fail on the D1=a default. SKIP becomes a non-zero exit under `--strict`. Output is passed through the live-report evidence sanitizer and never prints tokens, UFVKs, `utest1` addresses, payment URIs, or tunnel credentials.
