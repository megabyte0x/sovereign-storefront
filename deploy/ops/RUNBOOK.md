# Public testnet operations

Operator notes for the Pi stack (`deploy/compose.yaml`, project `ssf-public`) and the replica (`deploy/compose.replica.yaml`, project `ssf-replica`). Testnet only. Do not print tokens, viewing keys, payment URIs, or tunnel credentials.

Docker log rotation is already applied. Both compose files set `logging` to driver `local` with `max-size: 10m` and `max-file: "5"` on every service. Do not add a second logging block.

D1=a: there is no owned delivery node. Leave `WSS_HOSTNAME` and `SSF_WSS_ORIGIN` empty. Do not start the `delivery` service unless the `wss` profile is explicitly requested.

## Start order

Replica first, then the Pi. Named volumes are root-owned until a one-off `docker run --user 0` chowns them to `65532:65532`. Compose services stay non-root.

Replica (`ssf-replica`), in order:

```sh
docker compose -f deploy/compose.replica.yaml --env-file /srv/ssf/public-testnet.env up -d logos-b
docker compose -f deploy/compose.replica.yaml --env-file /srv/ssf/public-testnet.env up -d replica-agent
```

`replica-agent` waits until `logos-b` is healthy. It publishes only on `REPLICA_TAILNET_IP:8790`.

Pi, in order:

```sh
docker compose -f deploy/compose.yaml --env-file /srv/ssf/public-testnet.env up -d logos-a
docker compose -f deploy/compose.yaml --env-file /srv/ssf/public-testnet.env up -d scanner
docker compose -f deploy/compose.yaml --env-file /srv/ssf/public-testnet.env up -d seller
docker compose -f deploy/compose.yaml --env-file /srv/ssf/public-testnet.env up -d cloudflared
```

`seller` waits until `scanner` and `logos-a` are healthy. Admin is published only as `127.0.0.1:8788`. Buyer port 8787 stays on the Compose network. `cloudflared` has no ingress for 8788.

Never run two scanners with the same UFVK. One `scanner` container, one `scanner.json`.

## Pi down

The store is offline. Cloudflare Tunnel has no origin, so `https://store.agentmascot.app` does not serve the seller. Replica B keeps the published ciphertext files and the off-Pi archives in `/srv/ssf/backups` (mode 0700).

Restore onto a new host from the replica copy. Stop and disable the old Pi scanner before the new scanner serves. Do not bring the old Pi back with the same viewing key while the new scanner is running.

## Unpublish

There is no unpublish route. Admin is `POST /admin/products` and `GET /admin/health` only. A published product version is immutable (`product version is immutable`). Rows with `published = 0` stay off the catalogue, and nothing in this tree flips a published row back.

To take listings offline, stop `cloudflared` or `seller`. Do not hand-edit sqlite while the seller is running. Do not invent a withdraw call.

## Admin token rotation

`public-testnet` reads the token from `SSF_ADMIN_TOKEN_FILE` (`/var/lib/ssf/admin.token` on the seller volume, mode 0600). `SSF_ADMIN_TOKEN` in the environment is rejected. The value never goes in argv, cron, or this file.

1. Write a new file next to the old one with `umask 077`. Do not print it.
2. `chmod 0600` the new file, then replace `/var/lib/ssf/admin.token` with it.
3. `docker compose -f deploy/compose.yaml --env-file /srv/ssf/public-testnet.env restart seller`.
4. Confirm `http://127.0.0.1:8788/admin/health` is 401 without the new file and 200 with it. Do not paste the token into the check command line; pass it from the 0600 file in a way that does not echo it.

## Rescan from the birthday

There is no rescan subcommand. The scanner binary serves with `--config /var/lib/ssf/scanner/scanner.json`. The birthday is the `birthday` field in that file (mode 0600). `serve` continues from the persisted wallet, which was imported at that birthday.

If the scanner must be restarted, restart the one `scanner` container. Do not start a second scanner with the same UFVK. Do not delete `wallet.sqlite` while any scanner with that key might still be running. Rebuilding scan state on a new host is a `backup:live restore` into fresh directories after the original scanner is stopped and disabled, then `restore-ack`. It is not a second live process.

## Scanner behind lightwalletd

`scripts/public-doctor.ts` fails the `scanner` row when the scanner tip is more than 3 blocks from lightwalletd. The endpoint in `scanner.json` must be `https://testnet.zec.rocks:443`.

Restart the single scanner container and run the doctor again. Wait for `health` ready. Do not start another scanner to "catch up". A lag after restart is still one process.

## Pi power loss

Services use `restart: unless-stopped`. After power returns, confirm the start order above if a container did not come back, then run `deploy/ops/healthcheck.sh`. Do not start a second Compose project against the same volumes or the same UFVK.

## SD/SSD full

The Pi state disk is the NVMe SSD (`/dev/nvme0n1p2` on `/`). Docker's data-root is on that filesystem. Log rotation is already `10m` × `5` files per service.

`deploy/ops/backup.sh` keeps 14 archives locally and on the replica. Prune older `.ssbk` files if the disk is full. Do not delete the backup key (`/var/lib/ssf/backup.key`) or the newest archive. Do not delete `scanner.json`.

## Rotating the tunnel credentials

`deploy/cloudflared/config.yml` points at `credentials-file: /etc/cloudflared/creds/ssf-store.json`. Compose mounts `deploy/secrets/` read-only into cloudflared only. That directory is gitignored. Never commit it, never cat it, never copy it into a backup archive.

1. Create a replacement credential with `cloudflared` on a machine that can see the `agentmascot.app` zone. Do not record the JSON.
2. Install it as `deploy/secrets/ssf-store.json` mode 0600.
3. `docker compose -f deploy/compose.yaml --env-file /srv/ssf/public-testnet.env restart cloudflared`.
4. Confirm the store URL answers and the doctor `tls` row passes.
5. Delete the old credential file. Do not print either file.

## Backup

Nightly, on the Pi: `deploy/ops/backup.sh export` (see `deploy/ops/crontab.example`).

The script stops `seller` and `scanner`, runs `node --experimental-strip-types scripts/backup-live.ts export` inside a one-off seller container, and starts those two services again. Output goes to `/srv/ssf/backups` (mode 0700). Archives are mode 0600. Fourteen copies are kept. The backup key stays at `/var/lib/ssf/backup.key` on the seller volume and is not pushed.

Before the first push, and before every push, `deploy/ops/backup-guard.ts --check` reads the archive. If it contains a cleartext viewing-key shape, the script exits and does not rsync. The push target is `ssf-replica:/srv/ssf/backups`, also mode 0700, over `tailscale ssh`.

Restore drill: `deploy/ops/backup.sh verify`. That copies the newest replica archive back and runs `scripts/backup-live.ts verify`. It prints `complete: true` for a v2 archive. It does not print the key.

### `backup:live restore` step list

`scripts/backup-live.ts restore` writes into fresh directories only. It prints the next commands and runs none of them. Never run two scanners with the same UFVK.

1. Stop and disable the original scanner and seller. A restored stack replaces them. Two stacks with the same viewing key must never allocate receivers concurrently.
2. Run restore into empty directories:

   ```sh
   node --experimental-strip-types scripts/backup-live.ts restore \
     --archive <archive> --key-file <0600-key-file> \
     --seller-dir <new-empty-seller-dir> --scanner-dir <new-empty-scanner-dir>
   ```

   Files are 0600. Directories are 0700. Keep the scanner directory short: the socket path must be at most 100 bytes.
3. Acknowledge the new epoch. A restored scanner refuses to serve until this runs, and a second ack fails:

   ```sh
   scanner restore-ack --config <new-scanner-dir>/scanner.json --new-epoch --reserve-gap 1000
   ```

   `--reserve-gap` burns receiver indices past the restored high-water mark so receivers issued after the backup are not reissued. Use a larger gap if more invoices were issued after the backup.
4. Start only the restored scanner (`serve --config <new-scanner-dir>/scanner.json`). Point `SSF_SCANNER_SOCKET` at the printed socket.
5. Start the seller on the restored database and the restored scanner config. The admin token still comes from a 0600 file.
6. Rescan before first release. Restored snapshots are not release evidence. Wait until the restored scanner is caught up (doctor `scanner` row, fresh `checkedAt`) before any order is released.

Serve the restored seller identity from the same origin buyers pinned (`https://store.agentmascot.app`).

## Healthcheck

Every 5 minutes, `deploy/ops/healthcheck.sh` runs `node --experimental-strip-types scripts/public-doctor.ts --strict`. On a non-zero exit it posts the sanitized body from `deploy/ops/health-payload.ts` to `SSF_HEALTH_URL`. Set that variable in `/srv/ssf/ops.env` (mode 0600). Do not put the URL in cron. The payload drops viewing keys, payment URIs, bearer tokens, and tunnel-credential shapes.
