# Sovereign Storefront runbook

This is operator guidance for the fixture and real-demo modes in this repository. It is **not** a formal security audit, production-readiness statement, or capacity plan.

## Honest limits (do not overclaim)

- Independent Logos replica + browser decrypt is proven at **73 ciphertext bytes** (41 plaintext) only. Progressive larger replica retrieval was not a committed probe result. Live new-CID replica retrieval is skipped here.
- Compact-block **WalletRead is not wired**. Live zakura attribution was destination-UA. Do not call viewing-only scan proven.
- ZIP-321 **QR is unproven**. Copy/link of the exact URI are the verified alternatives. No Zashi/Zodl handoff claim.
- `minConfirmations` is **10**. Never mainnet. Never silently default to 0 or to the live-probe value 1.
- Browser↔seller control plane in this tree is localhost HTTP with possession proofs. Live Waku Light Push is not auto-constructed; real-demo throws instead of falling back to fixtures.

## Native dependencies

- Node.js >= 22 (local observation: Node 26 is fine).
- Optional live probes: `logosctl` 0.2.3 / `storage_module` 2.1.2; `ths` 0.2.1 zakura/regtest. Those are not started by `npm test`.
- Chromium at `/usr/bin/chromium` for Playwright.

## Ports, binds, TLS

| Bind | Default | Purpose |
|---|---|---|
| Public | `127.0.0.1:8787` | Catalogue, orders, status, recover, ciphertext, browser assets |
| Admin | `127.0.0.1:8788` | Separate process bind. Bearer token required. Not reachable via `/admin` on the public port. |

Override with `SSF_PUBLIC_HOST` / `SSF_PUBLIC_PORT` / `SSF_ADMIN_HOST` / `SSF_ADMIN_PORT`. Keep admin on loopback. This tree does not terminate TLS; put a local reverse proxy in front if you need HTTPS. The app origin can serve malicious JavaScript; CSP is not a substitute for a trusted origin.

## Configuration (no credentials in examples)

Required environment (values are names, not secrets):

- `SSF_MODE` — `fixture` or `real-demo`
- `SSF_NETWORK` — `test` or `regtest` (product network). Invoice network stays `test`. `mainnet` is rejected.
- `SSF_MIN_CONFIRMATIONS` — omit to use 10; must be a positive integer
- `SSF_MAX_HEALTH_AGE_MS`, `SSF_MAX_CIPHERTEXT_BYTES`, `SSF_MAX_PLAINTEXT_BYTES`, `SSF_INVOICE_TTL_MS`
- `SSF_DB_PATH` — sqlite file outside the repository
- `SSF_SELLER_KEY_ID` — public seller identity the buyer pins
- `SSF_DESTINATION` — testnet/regtest shielded unified address
- `SSF_ADMIN_TOKEN` — set from a local secret store; never commit it
- `SSF_ADAPTER_MESSAGING` / `SSF_ADAPTER_STORAGE` / `SSF_ADAPTER_SCANNER` — `fixture` or `real`. `real-demo` requires `real` for all three and injected adapters.

First-release size caps: ciphertext 73 bytes, plaintext 41 bytes.

## Key ownership

- Buyer purchase credentials are Gate A hex JSON (`privateKeyHex` / `publicKeyHex`), stored in IndexedDB, optionally exported as a **bearer secret**. Possession of the backup is possession of the purchase.
- Seller messaging identity is `seller-identity.json` next to the database (mode 0600). It is included in the encrypted seller backup.
- Product AES keys live in sqlite `product_keys` as wrapped material. They are restored with the database.
- **Spending keys never enter this service.** Viewing/attribution state is invoice destination + `attributionRef` + scanner observations. WalletRead UFVK is not present.

## Fixture mode

`SSF_MODE=fixture` seeds the 41-byte harmless fixture product and uses in-process memory adapters. It is for deterministic tests. It is not a real Logos or Zcash integration.

## Testnet wallet setup

1. Use a shielded testnet or zakura/regtest unified address. Transparent and mainnet addresses are rejected.
2. Pay the exact ZIP-321 URI (copy/link). QR rendering is a placeholder.
3. Wait for **10** confirmations before expecting release. Scanner health must be caught-up and fresh (`SSF_MAX_HEALTH_AGE_MS`).
4. Do not treat dashboard `network: test` while `Regtest` as public testnet.

## Availability promises actually supported

| Event | Buyer-visible behaviour |
|---|---|
| Storage replica down | New checkout rejected (`checkout unavailable`). Existing invoices remain recoverable from seller state. Independent replica retrieval is only proven to 73 bytes. |
| Scanner outage | New checkout rejected. Existing paid status must not be rewritten to unpaid; UI may show verification unavailable / waiting on scanner. |
| Seller restart | Durable sqlite + seller identity restore in-process. In-memory scanner receipts rehydrate via recache + rescan, not a new store API. |
| Backup restore | Live restore needs a **coordinated (v2)** archive (seller + scanner). State **after** the backup is not guaranteed. Origin continuity: a restored identity still has to be served from the origin the buyer pinned. |

There is no documented multi-month retention SLA. Keep sqlite and `seller-identity.json` with the operator's own backup cadence.

## Seller-only backup (v1, fixture and disposable instances only)

The v1 archive holds only the seller sqlite and `seller-identity.json`. It has
no scanner config, wallet state, allocations or reserved-address high-water
mark, so it is **not** a live restore: restoring it against a live scanner can
reissue receivers. `npm run backup:live -- verify` reports a v1 archive as
`complete: false`, and a coordinated restore refuses it. For the live stack use
the coordinated (v2) flow below.

Encryption: Web Crypto AES-256-GCM, magic `SSBK`, 32-byte key. Same maintained AES-GCM tooling as product files, without the 41-byte product cap.

```text
node --experimental-strip-types scripts/backup-check.ts
```

v1 operator flow (isolated fixture instance, disposable data only):

1. Stop writes. Export with `exportSellerBackup` (WAL checkpoint, sqlite + seller identity, `spendingKeysPresent: false`).
2. Store the 32-byte backup key outside the backup file.
3. Restore into a **separate** data directory and bind.
4. Serve the restored identity from the **same origin** the buyer pinned (`sellerOrigin` / `sellerKeyId` on the buyer record must not be rewritten).
5. A preexisting paid purchase recovers with the unchanged pre-loss buyer record over the authenticated status/recover transport (possession proof). No spending keys are transferred.

Recovery-point limitation: orders, payments, and identity created after the backup are not in the restore.

## Coordinated backup and restore (v2)

`npm run backup:live -- export|restore|verify` backs up the seller **and** the
scanner together. `npm run backup-check` runs the same v2 round trip on fixture
files, with no live services.

**What the archive contains** (AES-256-GCM, `SSBK` envelope, one sealed
manifest plus five entries, each with its sha256 and size):

- `seller/seller.sqlite` (checkpointed with `wal_checkpoint(TRUNCATE)`) and
  `seller/seller-identity.json` (the seller messaging identity).
- `scanner/scanner.json` (view-only config: UFVK and birthday).
- `scanner/.scanner.json.live-state/wallet.sqlite` and `scanner.sqlite`
  (wallet state, allocations, reserved-address high-water mark, history).
- Manifest facts: seller public key, scanner `accountId`/`sourceId`/`network`,
  and `reservedHighWater` taken from the scanner's `backup-info`.

**What it never contains:** the seed, mnemonic or any spending key (export
refuses a `scanner.json` with spending-key markers), the backup key, the admin
token, `live.env`, the scanner socket, `birthday-attestation.json`, the
scanner-owned `.scanner.json.live-state/state-binding` marker and the
compact-block cache. Treat the archive itself as secret: it holds the UFVK and
the seller identity private key. It is useless without the key file.

**Key file:** `.runtime/live/seller/backup.key` by default (`--key-file`). The
first export creates it with `umask 077` (mode 0600, 32 random bytes as hex) if
it is missing. It is never printed. Store it **separately** from the archives.

**Before the first coordinated backup:** state that this scanner binary has
never opened has no binding row, and `backup-info` (so `backup:live export`)
refuses it with `scanner state is not bound; restart scanner once before
backup`. Restart the live scanner once (`npm run infra:down` then
`npm run infra:up`) after building the scanner version with
`backup-info`/`restore-ack`, then back up.

### Export (both services stopped)

Export refuses while the seller or the scanner is running. It checks
`<scanner dir>/serve.pid` and `.runtime/live/seller/seller.pid` against
`/proc/<pid>/cmdline`, and also scans `/proc` for this repo's
`dist/service/main.js`/`scripts/start-live.ts` and for
`sovereign-storefront-scanner … serve --config <scanner.json>`. It also refuses
non-empty scanner `-wal`/`-journal` files.

1. Stop the seller: Ctrl-C (SIGINT) on the `npm run start:live` wrapper.
2. Stop the scanner: `npm run infra:down` (this stops the whole live stack).
3. Export:

   ```sh
   npm run backup:live -- export
   # optional: --out <archive> --key-file <file> --seller-db <file>
   #           --scanner-config <file> --scanner-bin <binary>
   ```

   The default archive is `.runtime/live/backups/coordinated-<timestamp>.ssbk`
   (0600). It never overwrites an existing archive. Output is the archive path,
   `version: 2`, `entries: 5`, a 16-hex-char seller key prefix, the scanner ids
   and `reservedHighWater`.
4. Check it: `npm run backup:live -- verify --archive <archive>`
   (prints `complete: true` for v2; exits 1 for a v1 archive).
5. Bring the stack back: `npm run infra:up`, then `npm run start:live`.

### Restore (into fresh directories)

```sh
npm run backup:live -- restore --archive <archive> \
  --seller-dir <new-empty-seller-dir> --scanner-dir <new-empty-scanner-dir>
```

Both targets must be empty or absent, and separate. Files are written 0600 and
directories 0700. Keep `<new-empty-scanner-dir>` short: the scanner socket
path (`<dir>/.scanner.json.live-state/scanner.sock`) must be at most 100 bytes,
and the tool warns if it is longer. Restore prints paths, `version: 2`,
`entries: 5` and then the next commands. **It runs none of them.** Run them in
order:

1. **Retire the original stack first, permanently.** Stop the original
   scanner and seller (Ctrl-C on the `start:live` wrapper, then
   `npm run infra:down` or stop the original `serve`), and disable anything that
   would start them again. Two stacks with the same viewing key must never
   allocate receivers concurrently: both would hand out the same diversifier
   indices. After a restore the original stack must not be restarted; the
   restored stack replaces it.
2. **New-epoch acknowledgement with a reserve gap:**
   `services/scanner/target/release/sovereign-storefront-scanner restore-ack --config <new-scanner-dir>/scanner.json --new-epoch --reserve-gap 1000`.
   A restored scanner state refuses to open or serve until this is done, and a
   second ack fails. The ack records a new source epoch, revokes the restored
   snapshot evidence, and advances the reserved high-water mark by
   `--reserve-gap N` past the restored `reservedHighWater` (it never lowers it).
   Receivers the original scanner handed out after the backup are recorded
   nowhere in the archive; burning the next N indices means they are never
   reissued to a new order. `--reserve-gap N` is required: a positive integer
   up to 1000000. Choose N larger than the number of invoices the original
   issued since the backup; 1000 is the suggested default (it only costs unused
   diversifier indices). If in doubt, use a larger N.
3. Start the restored scanner:
   `… sovereign-storefront-scanner serve --config <new-scanner-dir>/scanner.json`
   (detached, as `infra:up` does). Point `SSF_SCANNER_SOCKET` in `live.env` at
   the printed socket.
4. Start the seller on the restored data:
   `npm run build`, then
   `SSF_MODE=real-demo SSF_NETWORK=regtest SSF_ADMIN_TOKEN_FILE=<0600-token-file> SSF_SCANNER_CONFIG=<new-scanner-dir>/scanner.json SSF_DB_PATH=<new-seller-dir>/seller.sqlite npm run start:live`
   (`start:live` also applies the real-demo limits; see
   [live-runtime-config.md](./live-runtime-config.md)). The token file must
   exist with mode 0600; its value is never printed or passed in argv.
5. **Rescan before first release.** Nothing restored is release evidence. Wait
   until the restored scanner has finished a full scan pass under the new epoch
   and reports caught-up with a fresh `checkedAt` (at most
   `SSF_MAX_HEALTH_AGE_MS`), for example with `SSF_STRICT_LIVE=1 npm run infra:doctor`.
   Only then may any order be released. Recovery point: orders and receiver
   allocations made after the backup are not in the archive (the reserve gap
   only keeps their receivers from being reissued). Take a fresh coordinated
   backup after every batch of new orders you cannot afford to lose.

Serve the restored seller identity from the **same origin** the buyer pinned.

## Logging

Operational logs are allowlisted (`event`, `ts`, `method`, `path`, `status`, `ok`, `code`). Invoice records, memo/attribution contents, payment URIs, destinations, buyer credentials, and private keys are dropped. Sentinel private keys are required absences, not the only forbidden values. Whole-record invoice logging is prohibited.

Public Waku routing topics must not contain `ORDER_MARK` / `BUYER_MARK` / `PRODUCT_MARK`. Those markers belong in encrypted application JSON only.

## Threat limits

- A malicious seller can withhold a key or ship the wrong bytes. This is not atomic fair exchange.
- Messaging peers see network metadata. Storage/gateway operators see identifiers and access patterns.
- Compromised origin, extensions, and shared unlocked browsers remain in scope. Browser storage is not a hardware vault.
- Buyer possession of a delivery key cannot prevent redistribution. No DRM claim.
- Boundary tests in this repository are regression checks, **not** a formal security audit.

## Live runtime

The real-demo keys, default paths, start sequence, startup lines, readiness TTL
and shutdown are covered in [live-runtime-config.md](./live-runtime-config.md).
In short: run `npm run infra:up`, then `SSF_STRICT_LIVE=1 npm run infra:doctor`,
then `npm run build`, then `npm run start:live`. After that, publish through the
seller's private admin route:

```sh
SSF_ADMIN_TOKEN_FILE=.runtime/live/seller/admin.token \
node --experimental-strip-types scripts/publish-live.ts \
  --admin-url http://127.0.0.1:<admin-port> \
  --plaintext-file <path-to-plaintext-at-most-41-bytes> \
  --version <product-version> --amount-zat <integer-zatoshis> --description "<text>"
```

The token is read only from the `0600` file and never goes in argv. Stopping the
seller with Ctrl-C does not stop the stack; that is `npm run infra:down`.

## Safe shutdown

1. Stop accepting new checkouts (or stop the process).
2. Let in-flight ciphertext responses finish.
3. Close the public and admin binds (`SIGINT` / process exit runs `store.close()`).
4. Sqlite WAL checkpoint is part of backup export; a crash without checkpoint still leaves a recoverable WAL next to the db.

Do not copy live sqlite files without `PRAGMA wal_checkpoint(TRUNCATE)` if you need a consistent restore.

## Live manual L run (commands that succeeded on 2026-09-26)

Run from the worktree root. Source the live environment before any integration suite:

    set -a; . ./.runtime/live/live.env; set +a
    npm run infra:up
    SSF_STRICT_LIVE=1 npm run infra:doctor          # expect 6/6 PASS

Automated live suites (F2.1):

    SSF_STRICT_LIVE=1 npx vitest run -c vitest.integration.config.ts tests/integration/storage.test.ts
    SSF_LIVE_BACKUP=1 npx vitest run -c vitest.integration.config.ts tests/integration/live-backup.test.ts
    SSF_LIVE_RUNTIME=1 npx vitest run -c vitest.integration.config.ts tests/integration/live-runtime.test.ts
    SSF_STRICT_LIVE_WAKU=1 npx vitest run -c vitest.integration.config.ts tests/integration/waku.test.ts

Seller and manual session:

    npm run build:clean
    npm run start:live > .runtime/live/diag/manual-seller.log 2>&1 &
    node --experimental-strip-types scripts/live-observe.ts init --log .runtime/live/diag/manual-seller.log
    SSF_ADMIN_TOKEN_FILE=<0600 token file> node --experimental-strip-types scripts/publish-live.ts \
      --admin-url http://127.0.0.1:8788 --plaintext-file <path> \
      --version <v> --amount-zat 100000 --description <text>
    node --experimental-strip-types scripts/live-pay.ts fund --uri '<zcash: URI from the browser>'
    node --experimental-strip-types scripts/live-pay.ts mine --blocks <n>
    node --experimental-strip-types scripts/live-pay.ts confirmations --txid <txid>
    node --experimental-strip-types scripts/live-infra/logos-node.ts stop --node a
    node --experimental-strip-types scripts/live-infra/logos-node.ts status --node a
    node --experimental-strip-types scripts/live-infra/logos-node.ts start --node a
    node --experimental-strip-types scripts/live-observe.ts stage <id> --status PASS|FAIL|NOT_RUN --evidence "..."
    node --experimental-strip-types scripts/live-observe.ts suite <L-id> --ok|--fail --evidence "..."
    node --experimental-strip-types scripts/live-observe.ts finalize

Stop the seller only through the `scripts/start-live.ts` wrapper PID, after checking `/proc/<pid>/cmdline` (NUL-separated; use `tr '\0' ' '`). Do not paste invoice URIs, keys or backup contents into evidence; the recorder refuses secret-shaped values.

Known gaps: `logosctl watch` processes can outlive their callers; check `ps` for `logosctl.*watch` after a run. `live-observe` records build provenance only at `init`; re-init after any rebuild.
