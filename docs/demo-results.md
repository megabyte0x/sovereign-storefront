# Demo results (Task 10)

This is an execution record. It is **not** a production-readiness statement, security audit, or capacity plan. Skipped checks do not count as passing. Overall live demo: **not pass**.

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
