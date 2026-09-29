# Task 4: Rehearse locally, then deploy to the Pi (serial)

Each subtask is one subagent. Workers never print secrets, never paste the UFVK or tunnel credentials into chat or logs, and stop on any approval denial (`blocked`, not retry). Evidence is sanitized command output only. Pi changes over Tailscale SSH are granted (U7). Push to origin happens only at 4.5.

## 4.0 Local dress rehearsal on the aarch64 laptop

- **Owns:** `.runtime/public-rehearsal/**` (gitignored). Timebox 2 h.
- [ ] `deploy/build-images.sh`; `docker compose -f deploy/compose.yaml --env-file <rehearsal env> up -d` with `SSF_PUBLIC_ORIGIN` set to a quick-tunnel URL (`cloudflared tunnel --url http://127.0.0.1:8787`; the random hostname is test-only).
- [ ] Use a throwaway testnet UFVK (NOT the seller's) with a recent birthday, so the scanner syncs in minutes.
- [ ] `public-doctor.ts --strict` against the quick-tunnel origin. All rows PASS except `backup-age` (SKIP allowed only here, noted).
- [ ] `docker compose down` then `up`: state survives (products, orders, scanner generation); no container restart loops (`docker compose ps`).
- **Done:** ledgered doctor rows; peak RAM per service (`docker stats --no-stream`), so the Pi sizing is known.

## 4.0a Generate the seller testnet wallet and put its viewing key on the Pi

- **Owner:** one subagent, run on the laptop. **Owns:** `~/.local/state/ssf-seller-wallet/` (0700, outside the repo) and the Pi's `/srv/ssf/secrets/seller.ufvk` and `birthday.txt`. Timebox 60 min.
- **Tool:** a throwaway Rust crate under `$TMPDIR/seller-wallet-gen/`. It reuses the scanner's pinned crates: `zakura-keys =1.2.0` (orchard), `zcash_protocol =0.10.6` with `Network::TestNetwork`, `zip32 =0.2.1`, `zakura-client-backend =0.1.0-rc5` (lightwalletd TLS), `tonic =0.14.6`, plus `bip0039` and `getrandom`. Delete the crate afterwards.
- [ ] Connect to `https://testnet.zec.rocks:443` over validated TLS. Check that `GetLightdInfo.chain_name == "test"`. Use `GetLatestBlock` as the birthday height.
- [ ] Take 32 bytes of OS entropy and make a 24-word BIP-39 mnemonic. Derive `UnifiedSpendingKey::from_seed(TestNetwork, seed, AccountId::ZERO)`, then encode its UFVK. Check that it starts with `uviewtest1`.
- [ ] Write `seed-phrase.txt`, `seller.ufvk` and `birthday.txt` with `create_new` at mode 0600. Print only `birthday`, the UFVK prefix and its length. Never print the seed or the full UFVK, and never put either in chat, logs or reports.
- [ ] `tailscale ssh home@home 'sudo install -d -m 0750 -o home /srv/ssf /srv/ssf/secrets'`. Then copy `seller.ufvk` and `birthday.txt` through stdin redirection (`tailscale ssh home@home 'umask 077; cat > /srv/ssf/secrets/seller.ufvk' < …`) and check `stat -c %a` = 600 on the Pi.
- [ ] Tell the user: back up `seed-phrase.txt` offline, and import it into Zashi (testnet) or zingo-cli to see and spend the received TAZ. The seed never goes to the Pi or `ssf-replica`.
- **Verify:** the sha256 of the UFVK file is the same on the laptop and the Pi (compare hashes, not content); a secret-shape grep of the report finds 0 hits.

## 4.1 Pi preparation and Cloudflare Tunnel

- **Needs:** U3 browser login. The Pi is `home@home`; Docker and Compose are already installed. **Owns:** Pi host state; `deploy/hosts/pi.md` (non-secret inventory: device name, OS, disk type, Docker version). Timebox 90 min.
- [ ] Over `tailscale ssh home@home`: confirm `aarch64` and at least 40 GB free. The disk is 77% full with 54 GB free: stop and ask if under 40 GB. Enable `unattended-upgrades` and make sure `/srv/ssf` exists (0750, owner `home`).
- [ ] Confirm the state directory `/srv/ssf` lives on the SSD (`findmnt -T /srv/ssf`); Docker's data-root too (`docker info -f '{{.DockerRootDir}}'`).
- [ ] The user runs `cloudflared tunnel login` once (browser). Then `cloudflared tunnel create ssf-store`; `cloudflared tunnel route dns ssf-store store.agentmascot.app`; `cloudflared tunnel route dns ssf-store wss.agentmascot.app`. The credentials JSON goes only to `/srv/ssf/secrets/` (0600) on the Pi.
- [ ] Cloudflare zone settings for `agentmascot.app` (read first, then change only these): Rocket Loader OFF, Email Obfuscation OFF, HTML minify OFF, Web Analytics auto-inject OFF for these hostnames, Zaraz OFF, Bot Fight Mode OFF (it breaks WS upgrades), WebSockets ON, SSL mode Full.
- **Verify:** DoH shows `store.` and `wss.` as CNAMEs to `<tunnel-id>.cfargotunnel.com`; no inbound router ports were opened.

## 4.1b Prepare `ssf-replica` (parallel with 4.1)

- **Owns:** `ssf-replica` host state; `deploy/hosts/replica.md` (non-secret: provider Hetzner CX23, Helsinki, x86_64, Ubuntu 26.04.1, tailnet name). Timebox 60 min.
- [ ] User-side checks, asked once: Tailscale key expiry disabled for `ssf-replica`; Hetzner firewall 22/tcp removed after Tailscale SSH works (it does, verified 2026-09-26).
- [ ] Over `tailscale ssh root@ssf-replica`: install Docker Engine and the Compose plugin. Ubuntu 26.04 is new: try Docker's official apt repo first; if it has no 26.04 suite yet, use Ubuntu's `docker.io` plus `docker-compose-v2` packages and record which one was used. Enable `unattended-upgrades`. Create `/srv/ssf` (0750).
- [ ] `ufw default deny incoming`, `ufw allow in on tailscale0`, enable ufw. There are no public inbound ports at all.
- **Verify:** `docker run --rm hello-world`; `ufw status`; `ss -ltnp` shows nothing on the public interface except what the OS needs.

## 4.2 Logos A (Pi) and B (`ssf-replica`)

- **Owns:** Pi volume `logos-a-data`; replica volumes `logos-b-data`, `replica-agent` token. Timebox 90 min.
- [ ] `deploy/ship.sh pi`, `docker compose up -d logos-a` (8091 bound to the Pi's Tailscale IP).
- [ ] `deploy/ship.sh replica`; on `ssf-replica`, generate the agent token (`openssl rand -hex 32` into `/srv/ssf/secrets/replica.token`, 0600); copy it to the Pi's `/srv/ssf/secrets/` over `tailscale ssh`, never through chat; `docker compose -f compose.replica.yaml up -d`.
- [ ] Replication proof via the agent: upload an 8 MiB random file on A, `POST /v1/replicate`, `GET /v1/has` true with the right digest. Stop `logos-a`, `GET /v1/ciphertext/<cid>` returns the same sha256, start `logos-a`.
- **Verify:** both healthy; the agent is unreachable on `ssf-replica`'s public IPv4 (curl from the laptop without Tailscale routing times out); timings ledgered; independent peer ids.

## 4.3 Delivery node behind `wss.agentmascot.app`

- **Owns:** Pi volume `delivery-data`, cloudflared ingress. Timebox 60 min.
- [ ] `docker compose up -d delivery cloudflared`. Put `/dns4/wss.agentmascot.app/tcp/443/wss/p2p/<peer>` first in `WAKU_BOOTSTRAP_PEERS`, followed by 2+ public peers from `waku-peers.ts`.
- [ ] The headless round-trip spike from 1.3 against `wss.agentmascot.app`: 50/50.
- If G2 fell back to D1=a: ledger "skipped by G2", remove the `wss.` DNS route, and pin public peers only.

## 4.4 Scanner on testnet with the seller UFVK

- **Needs:** 4.0a (`/srv/ssf/secrets/seller.ufvk` and `birthday.txt` on the Pi, both 0600). **Owns:** Pi volume `scanner-state`. Timebox 3 h (mostly sync).
- [ ] Provision `scanner.json` with `--network test --lightwalletd https://testnet.zec.rocks:443 --birthday <h>` inside the scanner container; start it.
- [ ] Wait until the scanner tip is within 3 blocks of lightwalletd; ledger the sync time and the state volume size.
- **Verify:** doctor row `scanner` PASS.

## 4.5 Seller up, publish, push

- **Owns:** `/srv/ssf/public-testnet.env` (0600), Pi volume `seller-data`. Timebox 90 min.
- [ ] Env from `deploy/env/public-testnet.env.example`: `SSF_MODE=public-testnet`, `SSF_NETWORK=test`, `SSF_PUBLIC_ORIGIN=https://store.agentmascot.app`, `SSF_EMBED_ORIGINS=https://sovereign-store.pages.dev`, `SSF_MIN_CONFIRMATIONS=3`, `SSF_MAX_PLAINTEXT_BYTES=8388608`. Admin token: `openssl rand -hex 32` into a 0600 file.
- [ ] Env also sets `SSF_REPLICA_AGENT_URL=http://100.114.129.39:8790` and `SSF_REPLICA_TOKEN_FILE=/run/secrets/replica.token`.
- [ ] `docker compose up -d seller`; logs show `public`/`admin`/`ready`; `curl https://store.agentmascot.app/api/products` returns `[]`.
- [ ] Publish two demo ebooks (public-domain texts, ≤ 8 MiB each) via `ssh -L 8788:127.0.0.1:8788 <pi>`, then `scripts/publish-live.ts --admin-url http://127.0.0.1:8788 …`. Every `/assets/*` and `/embed.js` returns 200; `/api/products` lists both with `available:true`.
- [ ] `public-doctor.ts --strict` against `https://store.agentmascot.app`: every row PASS.
- [ ] Push `main` and `feat/public-testnet` to origin (deployment push grant).
