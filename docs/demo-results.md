# Demo results (Task 10)

This is an execution record. It is **not** a production-readiness statement, security audit, or capacity plan. Skipped checks do not count as passing. The historical local regtest run below did not pass; the separate public-testnet T01 run recorded here passed.

## Public-testnet T01 on the VPS — 2026-09-29

**PASS: eight of eight stages.** The run completed at 18:04:53 UTC; its private report was then finalized and independently validated. Playwright 1.55 drove persistent, isolated browser profiles on `ssf-replica` with its matching Chromium headless shell. The buyer was a fresh VPS testnet wallet using `ssf-buyer-sender 0.1.0 (zakura-client-backend 0.1.0-rc5)` against `https://testnet.zec.rocks:443/`.

One approved faucet claim funded that buyer with 1 TAZ. It did not count as a purchase. The sender paid two distinct 100,000-zat invoices with a 10,000-zat fee each; its final status was 99,780,000 spendable zatoshis, two sends, zero pending. The seller scanner and a separate view-only checker matched both mined payments. The seller, scanner, Logos origin, independent checker, and browser service were healthy after the run. Both seller orders had exactly one delivery package and reached `acknowledged` after their existing buyer profiles were reopened without another payment.

| Stage | Result | Evidence |
|---|---|---|
| `embed-invoice` | PASS | Popup invoice persisted; QR matched its URI; the same order survived a browser restart and backup import into a fresh profile before payment. |
| `receipt-observed` | PASS | Seller scanner matched the first sender transaction to a 100,000-zat Ironwood receipt. |
| `three-confirmations` | PASS | First payment reached three confirmations and the seller reported it paid. |
| `bytes-match` | PASS | Decrypted *Gift of the Magi* plaintext matched the published fixture SHA-256. |
| `recover-without-repay` | PASS | Relaunched buyer profile recovered the same plaintext without another send. |
| `restart-between` | PASS | Seller stopped with the second payment at one confirmation; the independent checker observed at least three while it was stopped. After restart the seller confirmed the payment, and the delivered plaintext matched the second fixture. |
| `origin-stop` | PASS | Purchase A's backup worked in a fresh profile while Logos origin A was stopped; replica B served matching plaintext, then A was restored. |
| `funds-received` | PASS | Independent view-only checker found both mined 100,000-zat payments. |

The origin and replica now share the VPS, so `origin-stop` proves node fallback on one host, not survival of a host outage. This was a fresh funded buyer and a fresh T01 run. The user chose the new VPS wallet as the final T01 buyer and waived importing or archiving the earlier zingo wallet on offline `haprocrates`; no backup or deletion was performed. The first completed run closed its browser pages at download start, before Waku acknowledgments finished. A no-payment reopen of each profile completed both acknowledgments; the runner now waits for the seller's acknowledgment before accepting a download.

## Historical local regtest run

Network label for every live payment below: **zakura/regtest**. `status.node.chain` was `"test"` while `network` was `Regtest`. That is not public Zcash testnet.

## Commands

| Command | Exit | Notes |
|---|---|---|
| `npx vitest run tests/unit/demo-check.test.ts` | 0 | 17 passed. Adapters not PASS when live uses memory. Replica absence is FAIL. Unrun two-node retrieve is FAIL unless origin-stop is explicitly unsafe |
| `npm test` | 0 | 14 files, **105 passed** |
| `npm run typecheck` | 0 | `tsc --noEmit` |
| `npm run build` | 0 | Vite `dist/browser` + service |
| `npx playwright test` | 0 | **28 passed** (`/usr/bin/chromium`) |
| `npm run test:integration` | 0 | **3 passed, 2 skipped**. Skips are not passes: live public testnet settlement; live Logos new-CID replica |
| `npm run demo-check` | 1 | `ok: false`, `liveAttempted: false`. Preflight adapters **SKIP** (live constructs memory). Replica **FAIL** (node-b `NO_DAEMON`). Live steps not run |

## Preflight

Fail-fast: missing ths/scanner, mainnet, fixture adapters, minConfirmations 0/1, or absent independent replica refuse live and refuse an overall pass. Config selecting real adapters is **not** PASS when live constructs memory. Two Logos nodes without origin-stop retrieve is not a preflight pass. Unlaunched Chromium is not a pass. Overall preflight is **not pass** unless every check is PASS.

Observed:

- Node v26.9.0, npm 11.19.1
- `ths` 0.2.1 `up_to_date`; doctor ok; already running (`default`). Endpoints: dashboard `http://127.0.0.1:32771`, lightwalletd `:32770`, rpc `:32768`
- Scanner: height 137, `wallet_sync.state=ready`. WalletRead **not** wired
- `minConfirmations` policy **10** (not 0, not live-probe 1)
- Adapters: **SKIP** — `SSF_ADAPTER_*=real` but live constructs `MemoryScanner`, `createMemoryMessaging()`, `createMemoryStorageAdapter()`
- Chromium `/usr/bin/chromium` present, **not launched** — preflight `chromium` is **SKIP**
- Origin: localhost HTTP. This tree does not terminate TLS
- Logos replica: **FAIL** — node-b `NO_DAEMON` (stale pid 1568980). Fail-fast; live not attempted. If two nodes were detected, origin-stop retrieve would either run (73-byte cap), FAIL if unrun, or SKIP only with an explicit "another process needs the node" reason. Origin was **not** stopped

## Live steps (`npm run demo-check`)

This run did **not** execute live steps (`liveAttempted: false`) because replica preflight **FAIL**.

| Step | Status | Evidence |
|---|---|---|
| Publish / checkout / payment / recover / backup / Waku / QR / replica-retrieve | not run | replica fail-fast stopped before `runLiveDemo` |

Prior-run chain evidence (zakura/regtest faucet, **not** this run, **not** in-app fulfillment): txid `e1bf91f52e90f358fd69c4542f95f1aa0d08623268715c10d1cd2160b30ebcb2`. `faucetConfirmations=1`, policy=10. `vin=0 vout=0 orchard.actions>0`. Destination-UA used for faucet; output index unknown. WalletRead not wired. Not public testnet. MemoryScanner payment remains SKIP, not PASS.

Destinations, proofs, seeds, UFVKs, spending keys, payment URIs, and memos are redacted.

## Timings and sizes (this run)

| Metric | Value |
|---|---|
| publishMs / scanMs / confirmMs / fulfillMs | not measured (`liveAttempted: false`) |
| retrieveMs | not measured (replica **FAIL**, origin not stopped) |
| plaintext | 41 bytes |
| ciphertext | 73 bytes (first-release max) |
| browser bundle | `dist/browser/assets/index-BNkjoZNl.js` 106.54 kB (gzip 29.71 kB) |
| RSS / CPU | not measured |

## Versions

| Component | Version |
|---|---|
| Node | v26.9.0 |
| npm | 11.19.1 |
| `@waku/message-encryption` | 0.0.38 |
| `@waku/utils` | 0.0.27 |
| TypeScript | 5.9.2 |
| Vite | 7.1.5 |
| Vitest | 3.2.4 |
| Playwright | 1.55.0 |
| ths | 0.2.1 (`zakuracore/zakura:1.4.0`) |
| logosctl / storage_module | 0.2.3 / 2.1.2 (Gate B pin; not live this run) |

Spike Waku: `@waku/sdk@0.0.36` (Task 1). Not constructed in the composed app.

## Privacy limitations (do not overclaim)

- Composed-app control plane is localhost HTTP with possession proofs, not live Waku Light Push
- Independent Logos replica + browser decrypt proven only at 73 ciphertext bytes (Gate B)
- Compact-block WalletRead is not wired
- ZIP-321 QR / Zashi / Zodl handoff unproven
- A malicious seller can withhold a key. Not atomic fair exchange
- No DRM. Browser storage is not a hardware vault

## Acceptance matrix

| Requirement | Tasks | Result | Evidence |
|---|---|---|---|
| Real browser Logos encrypted messaging | 1, 8, 10 | **unmet in composed app** | Task 1 live Waku: `spikes/results/messaging.json`, `spikes/messaging` e2e. Task 8/10 composed app: HTTP proofs only. This demo-check run did not reach live `messaging` |
| Public routing minimization | 1, 9 | met (unit/spike) | `tests/unit/security.test.ts` wired adapter markers; `tests/unit/logs.test.ts`; Task 1 routing inspection |
| Independent encrypted storage retrieval | 2, 6, 10 | **unmet this run** | Gate B: `docs/integration-report.md` 73 bytes after origin stop. Task 6 live new-CID skipped. Task 10 replica **FAIL** (node-b `NO_DAEMON`); live not attempted; origin not stopped |
| Shielded payment verification | 3, 7, 10 | **unmet in composed app**; Gate C/unit on zakura/regtest | this run did not reach live payment. MemoryScanner is not WalletRead and is not PASS. Prior-run faucet txid above is chain evidence only. `docs/integration-report.md` Gate C; `tests/integration/payment.test.ts` (public testnet skipped) |
| Scanner replay/checkpoint | 3, 7 | met (deterministic) | `tests/unit/payments.test.ts` crash-before-commit / `observations(from)` |
| Chain-revision catch-up | 3, 7 | met (deterministic) | `tests/unit/invoice-reduce.test.ts` stale/unhealthy health cannot release |
| Durable schema/idempotency | 4, 7 | met | `tests/unit/orders.test.ts`, `tests/unit/invoices.test.ts` disk reopen |
| Durable invoice issuance | 4 | met | `tests/unit/invoices.test.ts` unchanged id/amount/destination/attribution/expiry |
| Automatic browser recovery | 5, 8, 10 | met (Playwright); live demo-check recover **not run** | `tests/browser/recovery.spec.ts` IndexedDB reopen; this demo-check run did not reach recover |
| Draft includes product version | 5 | met | `tests/unit/checkout.test.ts` persist-before-create / failed invoice save replay |
| Purchase-specific credentials | 4, 5 | met | `tests/unit/credentials.test.ts`; `tests/unit/checkout.test.ts` two purchases differ, retry reuses |
| Optional portable recovery | 1, 5, 10 | met (Playwright); live demo-check backup **not run** | `tests/browser/recovery.spec.ts` fresh-context import + bearer warning; this demo-check run did not reach backup |
| Payment/delivery separation | 7, 8 | met | `tests/browser/purchase.spec.ts` confirming ≠ paid, failed delivery not unpaid; `tests/unit/fulfillment.test.ts` |
| Invoice-level settlement | 7 | met | `tests/unit/invoice-reduce.test.ts` surplus / no partial aggregation / single-receipt reorg |
| Shared first-release authorization | 7 | met | `tests/unit/fulfillment.test.ts` prepare→crash→reorg→recover does not disclose |
| Status exceptions | 7, 8 | met | purchase.spec confirmed+review; awaiting+verification unavailable; `tests/unit/security.test.ts` scanner outage |
| Cross-order authorization | 7, 8 | met | `tests/unit/fulfillment.test.ts` buyer A vs B; `tests/unit/security.test.ts` |
| Exception policy/reorgs | 7 | met (labelled synthetic) | `tests/unit/invoice-reduce.test.ts`, `tests/unit/fulfillment.test.ts`. Not live reorg |
| Checkout availability | 6, 8 | met | `tests/unit/availability.test.ts`; purchase.spec product view refuses checkout |
| Expired invoice closure | 5, 7, 8 | met | checkout.test / purchase.spec / recovery.spec expired unpaid copy |
| Confidentiality/authentication | 1, 2, 6, 7, 9 | met (tests) | wrong identity / corrupt envelope: credentials, gateway, fulfillment, security tests |
| Public/admin separation | 6, 8, 9 | met | purchase.spec admin off public bind; security.test unauthorized admin + gateway exhaustion |
| Buyer metadata minimization | 5, 8, 9 | met | `tests/browser/privacy.spec.ts`; `tests/unit/logs.test.ts` allowlisted logs |
| Seller loss recovery | 9 | met | `scripts/backup-check.ts` / `npm run backup-check`; `tests/unit/security.test.ts` isolated restore |
| Safe real-demo configuration | 8, 10 | met | `tests/unit/config.test.ts`; `tests/unit/demo-check.test.ts` mainnet/fixture/0/1 rejected |
| Honest scale/readiness claims | 2, 10 | met | this file: 73-byte cap, no 4KiB/64KiB, no invented capacity |

## Unmet (do not treat as passing)

1. Live Waku Light Push in the composed browser/seller app
2. Independent replica retrieval after stopping origin (this run replica **FAIL**, live not attempted); new-CID replica
3. Compact-block WalletRead / UFVK viewing-only scan; in-app settlement (MemoryScanner is not WalletRead and is not PASS)
4. Public Zcash testnet settlement
5. ZIP-321 QR / wallet-open / Zashi/Zodl handoff
6. Open browser checkout / reopen same browser (Chromium not launched; live not attempted)
7. Overall `demo-check` pass (`ok: false`, `liveAttempted: false`). Adapters **SKIP** because live would construct memory. Replica absence is fail-fast. Prior-run faucet txid is chain evidence, not fulfillment PASS

## Live L run (2026-09-26, regtest)

Generated from `.runtime/live/demo/report.json` (0600, local only), written by `scripts/live-observe.ts finalize` and re-read through `validateLiveReport` (ok, no errors).
Totals: 33 PASS, 0 FAIL, 1 NOT_RUN.

- Network: regtest (local regtest only; no testnet or mainnet claim, not production).
- Build: commit `bd5e53ca343c`, dirty working tree (diff sha256 `dc4fc78d2122`), clean build at 2026-09-26T07:22:55.447Z. Two builds were used: the report records the first. The import fix forced a rebuild and seller restart mid-run, so `fresh-context-import`, `decrypt-equal`, `normal-delivery` and `response-loss-reconnect` ran on a second, unrecorded dirty build. `live-observe` captures provenance only at `init`.
- Adapters: scanner `zcash-scanner-socket` 0.1.0, storage `logos-storage` dd6529621abf, messaging `waku-lightpush-filter` 0.0.36.
- Run: manual session driven by the user in the browser, with the orchestrator doing publish, funding, mining, node stop/start and seller DB checks. Run 1 was abandoned (stale demo product served, first-press invoice and interrupt missed) and archived; this section records run 2 only.

### Matrix rows

| Row | Status | Evidence |
|---|---|---|
| L01 | PASS | ['publish: fresh seller db; published version v-run2, 14 plaintext bytes, replica ok, served at /api/product'] |
| L02 | PASS | ['suite: F1 gate cargo test --locked: 101 scanner tests pass incl protocol_vectors and projection tests; fmt and clippy clean'] |
| L03 | PASS | ['two-invoices: two Buy presses; seller db holds two v-run2 invoices, both 100000 zat', 'fund-a: faucet funded invoice A only, 100000 zat; invoice B never funded', 'b-stays-locked: invoice B never funded; seller delivery state locked with 0 packages for the whole run'] |
| L04 | PASS | ['restart: 10th block mined while seller down; after restart ready products=1, invoice A released once (1 package, transport-accepted), invoice B still locked', 'suite: live run2: seller restarted twice, invoices and allocations unchanged; fulfillment-crash.test.ts 12/12 in F1 gate'] |
| L05 | PASS | ['below-threshold: 9 confirmations: seller settlement confirming, release_eligible 0, delivery locked, 0 packages; browser showed Locked', 'threshold: 10th confirmation mined; seller released invoice A once after restart'] |
| L06 | PASS | ['suite: deterministic fault tests (labelled deterministic): fulfillment.test.ts reorg cases and invoice-reduce.test.ts in F1 gate 580/580'] |
| L07 | PASS | ['interrupt: seller wrapper stopped at 9 confirmations with delivery locked and 0 packages; no release before stop', 'restart: 10th block mined while seller down; after restart ready products=1, invoice A released once (1 package, transport-accepted), invoice B still locked', 'suite: fulfillment-crash.test.ts 12/12 per-openStore crash boundaries in F1 gate'] |
| L08 | PASS | ['suite: invoice-reduce.test.ts and payments.test.ts in F1 gate; scanner projection tests in cargo test 101 pass'] |
| L09 | PASS | ['waku-recover: after seller restart, request id pressed; page Paid/Sent/Verification available; downloaded file, no new payment', 'ack: seller delivery_state for invoice A moved sent_unacknowledged -> acknowledged after browser decrypt', 'normal-delivery: uninterrupted purchase: 10 confirmations, seller released one package and it was acknowledged, 14 bytes equal to published, no restart'] |
| L10 | PASS | ['normal-delivery: uninterrupted purchase: 10 confirmations, seller released one package and it was acknowledged, 14 bytes equal to published, no restart', 'suite: live seller refuses POST /api/orders with 404 in real-demo; browser-r3-minors M1/M7 select unavailable not HTTP'] |
| L11 | PASS | ['interrupt: seller wrapper stopped at 9 confirmations with delivery locked and 0 packages; no release before stop', 'restart: 10th block mined while seller down; after restart ready products=1, invoice A released once (1 package, transport-accepted), invoice B still locked', 'waku-recover: after seller restart, request id pressed; page Paid/Sent/Verification available; downloaded file, no new payment', 'fresh-context-import: new browser profile imported the invoice A backup; same request id listed'] |
| L12 | PASS | ['replica-b: strict doctor logos-replication PASS after publish of a new cid', 'origin-stop: node A stopped (status stopped, doctor logos-a FAIL); seller still served ciphertext 200 and availability storageReplica true. logos-node stop exited 1 despite the stop (known F2.1 defect)', 'gateway-restart: node A restarted via logos-node start, infra:up re-proved replication digest_match, strict doctor 6/6', 'fresh-context-import: new browser profile imported the invoice A backup; same request id listed', 'decrypt-equal: fresh-context decrypt downloaded 14 bytes, cmp-equal to the published plaintext'] |
| L13 | PASS | ['two-invoices: two Buy presses; seller db holds two v-run2 invoices, both 100000 zat', 'suite: F1.4 Rust zip321 parser round trip plus zip321-roundtrip.test.ts 4/4; payment-request.test.ts decodes the QR image'] |
| L14 | PASS | ['suite: live run2: node A stopped, availability stayed storageReplica true and paid purchases still delivered; scanner-outage-http tests in gate'] |
| L15 | PASS | ['suite: SSF_LIVE_BACKUP=1 live-backup.test.ts 7/7 on the live stack in F2.1'] |
| L16 | PASS | ['publish: fresh seller db; published version v-run2, 14 plaintext bytes, replica ok, served at /api/product', 'decrypt-equal: fresh-context decrypt downloaded 14 bytes, cmp-equal to the published plaintext', 'suite: SSF_STRICT_LIVE=1 storage.test.ts 5/5 in F2.1 (41B ok, 42B and 74B rejected, tamper rejected); three browser decrypts cmp-equal'] |

### Workflow stages

| Stage | Status | Evidence |
|---|---|---|
| publish | PASS | ['fresh seller db; published version v-run2, 14 plaintext bytes, replica ok, served at /api/product'] |
| replica-b | PASS | ['strict doctor logos-replication PASS after publish of a new cid'] |
| two-invoices | PASS | ['two Buy presses; seller db holds two v-run2 invoices, both 100000 zat'] |
| fund-a | PASS | ['faucet funded invoice A only, 100000 zat; invoice B never funded'] |
| below-threshold | PASS | ['9 confirmations: seller settlement confirming, release_eligible 0, delivery locked, 0 packages; browser showed Locked'] |
| threshold | PASS | ['10th confirmation mined; seller released invoice A once after restart'] |
| interrupt | PASS | ['seller wrapper stopped at 9 confirmations with delivery locked and 0 packages; no release before stop'] |
| restart | PASS | ['10th block mined while seller down; after restart ready products=1, invoice A released once (1 package, transport-accepted), invoice B still locked'] |
| waku-recover | PASS | ['after seller restart, request id pressed; page Paid/Sent/Verification available; downloaded file, no new payment'] |
| origin-stop | PASS | ['node A stopped (status stopped, doctor logos-a FAIL); seller still served ciphertext 200 and availability storageReplica true. logos-node stop exited 1 despite the stop (known F2.1 defect)'] |
| gateway-restart | PASS | ['node A restarted via logos-node start, infra:up re-proved replication digest_match, strict doctor 6/6'] |
| fresh-context-import | PASS | ['new browser profile imported the invoice A backup; same request id listed'] |
| decrypt-equal | PASS | ['fresh-context decrypt downloaded 14 bytes, cmp-equal to the published plaintext'] |
| ack | PASS | ['seller delivery_state for invoice A moved sent_unacknowledged -> acknowledged after browser decrypt'] |
| b-stays-locked | PASS | ['invoice B never funded; seller delivery state locked with 0 packages for the whole run'] |
| normal-delivery | PASS | ['uninterrupted purchase: 10 confirmations, seller released one package and it was acknowledged, 14 bytes equal to published, no restart'] |
| response-loss-reconnect | PASS | ['reload then request id again showed the same delivered purchase; seller still 3 orders, 1 invoice each, no second payment'] |
| T01 | NOT RUN | Not run by decision D4. |

### Scope notes

- L12 covers the origin (node A) stop plus serving from replica B, the node A restart with replication re-proved (`gateway-restart`), and a fresh-context import and decrypt (`fresh-context-import`, `decrypt-equal`).
- L02, L06, L07 and L08 rest on deterministic unit and Rust tests from the F1 gate, not on live fault injection; their evidence says so.
- Fresh-context import initially failed: the browser importer only accepted legacy test-network invoices with `attributionRef`, so no live regtest backup could be imported. Fixed in `src/browser/purchases.ts` (`sanitizeLiveInvoice`, covered by `tests/unit/purchases-live-invoice-import.test.ts`) and re-run in the same session.
- Automated `storage-origin-stop` (F2.1) failed: `logos-node.ts stop` threw "daemon still running after daemon stop" because the daemon reports `not_running` once stopped and the stop poll only accepted `stopped`/`not_configured`. Fixed after the run (`scripts/live-infra/logos-node.ts`, unit case added); a real stop/start of node A then exited 0 and doctor stayed 6/6. The automated suite was not re-run.
- Two `logosctl watch storageDownloadDone` processes on node B outlived their callers during this run and were killed by hand. Watcher cleanup is an open leak.
