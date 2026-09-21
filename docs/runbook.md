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
| Backup restore | State **after** the backup is not guaranteed. Origin continuity: a restored identity still has to be served from the origin the buyer pinned. |

There is no documented multi-month retention SLA. Keep sqlite and `seller-identity.json` with the operator's own backup cadence.

## Seller backup and restore

Encryption: Web Crypto AES-256-GCM, magic `SSBK`, 32-byte key. Same maintained AES-GCM tooling as product files, without the 41-byte product cap.

```text
node --experimental-strip-types scripts/backup-check.ts
```

Operator flow (isolated instance, disposable data):

1. Stop writes. Export with `exportSellerBackup` (WAL checkpoint, sqlite + seller identity, `spendingKeysPresent: false`).
2. Store the 32-byte backup key outside the backup file.
3. Restore into a **separate** data directory and bind.
4. Serve the restored identity from the **same origin** the buyer pinned (`sellerOrigin` / `sellerKeyId` on the buyer record must not be rewritten).
5. A preexisting paid purchase recovers with the unchanged pre-loss buyer record over the authenticated status/recover transport (possession proof). No spending keys are transferred.

Recovery-point limitation: orders, payments, and identity created after the backup are not in the restore.

## Logging

Operational logs are allowlisted (`event`, `ts`, `method`, `path`, `status`, `ok`, `code`). Invoice records, memo/attribution contents, payment URIs, destinations, buyer credentials, and private keys are dropped. Sentinel private keys are required absences, not the only forbidden values. Whole-record invoice logging is prohibited.

Public Waku routing topics must not contain `ORDER_MARK` / `BUYER_MARK` / `PRODUCT_MARK`. Those markers belong in encrypted application JSON only.

## Threat limits

- A malicious seller can withhold a key or ship the wrong bytes. This is not atomic fair exchange.
- Messaging peers see network metadata. Storage/gateway operators see identifiers and access patterns.
- Compromised origin, extensions, and shared unlocked browsers remain in scope. Browser storage is not a hardware vault.
- Buyer possession of a delivery key cannot prevent redistribution. No DRM claim.
- Boundary tests in this repository are regression checks, **not** a formal security audit.

## Safe shutdown

1. Stop accepting new checkouts (or stop the process).
2. Let in-flight ciphertext responses finish.
3. Close the public and admin binds (`SIGINT` / process exit runs `store.close()`).
4. Sqlite WAL checkpoint is part of backup export; a crash without checkpoint still leaves a recoverable WAL next to the db.

Do not copy live sqlite files without `PRAGMA wal_checkpoint(TRUNCATE)` if you need a consistent restore.
