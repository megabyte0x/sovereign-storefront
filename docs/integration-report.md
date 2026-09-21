# Integration report (Gates A–C)

Parent review after Tasks 1–3. This is not a claim that the MVP works. Tasks 4–10 may proceed against the pins below. Limitations are binding: do not treat unproven items as settled.

Evidence: `spikes/results/messaging.json`, `spikes/results/storage.json`, `spikes/results/payments.json`, plus controller re-runs of unit suites. Live Logos/storage probes were not re-run by the parent after the original implementers.

## Verdict

| Gate | Result | Notes |
|---|---|---|
| A messaging | **PASS with concerns** | Real Waku Network Light Push/Filter + `@waku/message-encryption`. Not logos-chat. |
| B storage | **PARTIAL** | Independent replica + browser decrypt proven at **73 ciphertext bytes** only. `pass: false`. |
| C payments | **PASS zakura/regtest, not public testnet** | Live shielded Orchard faucet + destination-UA matching. WalletRead/compact-block scan **not** executed. ZIP-321 QR/wallet-open **not** executed. |

## Gate A — messaging

**Pins**

- `@waku/sdk@0.0.36` `createLightNode`, `Protocols`, `DefaultNetworkConfig`
- `@waku/message-encryption@0.0.38` `generatePrivateKey`, `getPublicKey`, ECIES encoder/decoder, `DecodedMessage.verifySignature`
- `@waku/utils@0.0.27` `createRoutingInfo`, `bytesToHex` / `hexToBytes`
- Network: The Waku Network, `clusterId: 1`, `numShardsInCluster: 8`, `defaultBootstrap`
- Credential store: IndexedDB. Export **supported**: JSON `privateKeyHex` / `publicKeyHex`
- Rerun: `cd spikes/messaging && npm ci && npm test && npm run test:live && npm run test:e2e`

**Proven:** wrong-seller reject; Light Push ack is not an application response; encrypted browser→network→seller; reconnect one logical response (wait for a *new* accepted message); IndexedDB restart; export/import; `ORDER_MARK` / `BUYER_MARK` / `PRODUCT_MARK` absent from public topic and unencrypted envelope fields.

**Not proven / do not claim**

- logos-chat / de-MLS browser session SDK (none exists; do not invent one)
- `isConnected()` / health as a release signal (can be Unhealthy while push/filter work)
- Playwright bundled Chromium (e2e used `/usr/bin/chromium`)

**Task 4 mapping:** `CredentialAdapter` uses Gate A keypair + hex export/import. `credentialId` is a local reference, never a server-trusted identity.

## Gate B — storage

**Pins**

- logosctl **0.2.3**; `storage_module` **2.1.2** (root hash `19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740`)
- Completion events: `storageUploadDone` / `storageDownloadDone`; `fetch()` is acceptance-only
- Crypto: AES-256-GCM via Web Crypto, format `SSF1 || 12-byte nonce || ciphertext+tag`
- Local AE max plaintext 8 MiB; **no streaming**
- **First-release max for independent replica + browser: 73 bytes ciphertext (41 plaintext)**
- Rerun: `cd spikes/storage && node --test crypto.test.mjs gateway.test.mjs evidence.test.mjs` then `node probe.mjs` with two nodes already up

**Proven:** modified ciphertext rejected before plaintext; two nodes distinct peer IDs/data dirs; replica retrieve after origin `storageStop`; decoy plaintext unused; restricted HTTPS gateway; Chromium decrypt matched fixture.

**Not proven / do not claim**

- Progressive larger replica retrieval (4 KiB / 64 KiB were never a committed probe result)
- Streaming
- Cloud object store as Logos

**Task 6 mapping:** `StorageAdapter` / `CryptoAdapter` / gateway must keep this ciphertext format and the 73-byte independent-retrieval cap until a later probe raises it.

## Gate C — payments

**Pins**

- Live backend: **ths 0.2.1** zakura/regtest (`zakuracore/zakura:1.4.0`, app/lightwalletd 0.2.1). `status.node.chain` may be `"test"` while `network` is `Regtest` — still not public testnet.
- Intended scanner (not live-wired): `zcash_client_backend` 0.24.0 + `zcash_client_sqlite` 0.22.0, viewing-only via UFVK. MIT OR Apache-2.0. sqlite crate is beta.
- Live observation path: dashboard `GET /api/v1/status`, `GET /api/v1/accounts`, `POST /api/v1/faucet`, `GET /api/v1/transactions/{txid}`
- Live attribution: **destination UA** (equal amount to a different account UA does not release)
- Documented WalletRead attribution (unexecuted): **random memo** via `WalletRead::get_memo(NoteId)`
- App `minConfirmations`: **10**. Live probe used **1** (not 0). `maxHealthAgeMs`: 120000. Invoice expiry: 86400000 ms.
- ZIP-321 encoder accepts testnet shielded and `uregtest1`; rejects transparent and mainnet. No QR / wallet-open observed.
- Live `outputId`: `txid:orchard` with `indexUnknown: true` (not fake `:0`)
- Rerun live: `ths start --no-open` then `cd spikes/payments && node --experimental-strip-types --test tests/*.test.ts`

**Proven:** unmatched output cannot release; amount-only matching rejected; seller checkpoint advances only after commit; synthetic reorg labelled synthetic; live shielded Orchard (`vin=0`, `vout=0`, `orchard.actions>0`); equal-amount other-UA does not match.

**Not proven / do not claim**

- Compact-block viewing-only scan / UFVK from `GET /accounts` (0.2.1 omits UFVK)
- Public Zcash testnet settlement
- ZIP-321 QR, wallet memo/receiver preservation, Zashi/Zodl handoff
- Per-invoice shielded destinations via WalletRead

**Task 4 mapping:** `getOrCreateInvoice` must persist immutable amount, destination, `attributionRef`, product version, expiry. Live zakura strategy is destination-UA; keep a random `attributionRef` for the WalletRead memo path. Do not match on amount. Network field for zakura probes may be `test` as reported by the node; product network remains testnet/regtest-only, never mainnet.

## Parent rulings carried into Tasks 4–10

1. Credential material is Gate A hex JSON, exportable, IndexedDB-backed.
2. Product ciphertext is SSF1 AES-256-GCM; independent Logos replica proven only to 73 bytes.
3. Scanner adapter may use a test double in Task 4–7 unit tests. Live zakura dashboard mapping is labelled, not WalletRead. Do not call compact-block viewing proven.
4. `minConfirmations` default 10; do not silently default to 0 or to the live-probe 1 in real-demo mode.
5. Fake settlement evidence remains forbidden.

## Combined feature branch

`feat/mvp-build` after merging review-clean Tasks 1–3 (not pushed).
