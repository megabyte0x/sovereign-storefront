# Self-hosting on public Zcash testnet

This guide describes the public-testnet deployment in [`deploy/README.md`](../deploy/README.md). It is an operator guide for one seller instance: the Raspberry Pi runs the seller, view-only scanner, Logos Storage origin A and Cloudflare Tunnel; a separate `ssf-replica` host runs storage replica B and its replica agent. The application is configured for Zcash testnet (`SSF_NETWORK=test`), not regtest or mainnet. **Testnet only: TAZ has no real value. Never configure this deployment for mainnet.**

## Requirements and boundaries

- A Raspberry Pi or compatible aarch64 Linux host, Docker Engine and Compose, and an independent x86_64 `ssf-replica` host joined to the seller's Tailscale network.
- A Cloudflare-managed domain, Cloudflare Tunnel, and an existing seller/testnet setup. Create and protect deployment credentials using the secure instructions in `deploy/README.md`; do not put the admin token or viewing key in the environment file.
- A locally available Logos `storage_module` package for image building, as specified in the deploy guide. The documented build path builds Pi images on aarch64 and builds the replica images on `ssf-replica`.

The automation boundary for acceptance testing is narrower than ordinary deployment automation:

- Never import, inspect, unlock, or spend from a user's personal wallet or the seller's spending seed.
- A separately created, disposable, capped testnet-only buyer wallet may send only after the T01 runner proves persistent-profile recovery and backup import, and verifies the displayed QR against the exact invoice. It must be funded with public testnet TAZ; if a verified faucet is unavailable or insufficient, a one-time external transfer to that fresh test receiver is required. A funding transfer is not a purchase. No payer CLI version is pinned or verified yet; do not infer support from the regtest payment-test-wallet.
- T01 also requires two real testnet invoice payments, independent seller viewing-only receipt evidence, and all eight stages in a validated report. Do not publish wallet state, invoice identifiers, receivers, memos, payment URIs, browser backups, or UFVKs.

These are acceptance requirements, not a claim that automation is ready or that T01 passed. The current worktree has no verified public T01 report; no public-testnet payment result is claimed.

The seller service does not hold spending keys. The scanner uses a viewing key to observe the seller's testnet wallet; protect it as sensitive wallet information even though it cannot authorize spending. Payment requests and the buyer's wallet are outside the seller's deployment automation.

## Hosting layout

- The Pi runs the seller, view-only scanner, Logos Storage origin A and `cloudflared`.
- `ssf-replica` runs Logos Storage replica B and the replica agent.
- Buyer traffic reaches the seller on its Compose network at port 8787. Cloudflare Tunnel publishes only the storefront (`store.agentmascot.app` in this deployment) to `http://seller:8787`; it has no admin ingress.
- Admin is bound to Pi loopback at `127.0.0.1:8788`. Logos origin port 8091 and replica-agent port 8790 are tailnet-only. D1=a: no owned WSS delivery node; leave `WSS_HOSTNAME` and `SSF_WSS_ORIGIN` empty.

## Build, configure and start

Build the provenance-bearing Pi images on the aarch64 host, with dependencies installed and the pinned Logos module file present:

```sh
npm run build:clean
deploy/build-images.sh
deploy/ship.sh pi
deploy/ship.sh replica
```

`build:clean` generates `dist/build-info.json`, which is copied into the seller image and required by public deployment-evidence capture. `ship.sh` uses Tailscale SSH/rsync and never copies `deploy/secrets/`. It builds the x86_64 replica images on `ssf-replica`; it does not emulate them on the Pi.

On both hosts, install the shipped environment example as `/srv/ssf/public-testnet.env` with mode `0600`. Set `PI_TAILNET_IP` and `REPLICA_TAILNET_IP` to the respective `tailscale ip -4` values. Keep the replica bearer token in a separate 0600 file on each host, and keep the seller UFVK in `scanner.json` (0600), not in the env file. Set the scanner endpoint to `https://testnet.zec.rocks:443` with test-network parameters. Never reuse regtest scanner state for testnet.

Configure Cloudflare Tunnel credentials as a 0600 file under `deploy/secrets/` and route the storefront hostname to `http://seller:8787`. Keep port 8788 and the admin API out of tunnel ingress. The supplied template routes `store.agentmascot.app`; adapt the tunnel/DNS hostname and `SSF_PUBLIC_ORIGIN` together when using another domain. Keep `WSS_HOSTNAME` and `SSF_WSS_ORIGIN` empty for this D1=a deployment.

Start replica B before the Pi:

```sh
docker compose -f deploy/compose.replica.yaml --env-file /srv/ssf/public-testnet.env up -d
docker compose -f deploy/compose.yaml --env-file /srv/ssf/public-testnet.env up -d
node --experimental-strip-types scripts/public-doctor.ts --strict
```

Before first start, Compose volumes are root-owned; change their ownership to UID:GID `65532:65532` with a one-off `docker run --user 0`, then run the services as the configured non-root user. `--strict` treats every SKIP as failure. The doctor checks TLS, public/admin separation, HTML integrity, scanner sync, both Logos nodes/replication, embed SRI and backup age.

For exact Compose volume names, host paths, tunnel configuration, admin-secret installation and restoration commands, follow the linked [`deploy/README.md`](../deploy/README.md) and [`deploy/ops/RUNBOOK.md`](../deploy/ops/RUNBOOK.md). Never paste credentials into this guide.

## File-size limits

Public-testnet accepts plaintext files up to 8 MiB. SSF1 adds 32 bytes (magic, nonce and authentication tag), so the maximum ciphertext is 8 MiB + 32 bytes. The configured plaintext limit may be lower; publishing, storage and the seller gateway enforce that configured ceiling, while buyer recovery independently enforces the hard public-testnet maximum. Real-demo retains its 41-byte plaintext limit.

## Availability and trust

- **Lightwalletd liveness trust:** the scanner depends on the public `https://testnet.zec.rocks:443` lightwalletd for chain data. It can withhold or delay blocks (a liveness failure); it cannot forge shielded notes. Keep scanner network parameters bound to testnet.
- **Served-JavaScript trust:** Cloudflare terminates TLS for the public storefront and serves JavaScript to buyers. Cloudflare could alter the JavaScript served to a buyer. It cannot read encrypted files, Waku payloads, or shielded payments merely by terminating TLS. Buyers still trust the code they receive; SRI can help pin the separately hosted embed script, but does not make the storefront origin itself untrusted or eliminate browser/hosting trust.
- **Replica limits:** replica B on `ssf-replica` keeps encrypted files and backups when the Pi's storage is down. It is not a storefront failover: the store itself is offline while the Pi is down. File copies on B do not provide the seller service, checkout, scanner or payment processing.
- The storage replica is not a guarantee of permanent availability. Keep and verify protected backups, and plan a restore rather than assuming the replica is a hot standby.

