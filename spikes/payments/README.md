# Gate C spike: Zcash scanner, invoice attribution, wallet handoff

Deterministic probe of the application `Scanner` / `ScanCheckpoint` / `ChainRevision` contract against documented `zcash_client_backend` 0.24.0 `WalletRead` APIs and ZIP-321. Live shielded **zakura/regtest** receipts were observed. This is not public testnet evidence. Seed, UFVK, spending keys, payment URIs, and memos are not recorded here.

## Question

Can a viewing-only Zcash scanner attribute a shielded payment to one invoice, replay from a seller-owned checkpoint, and refuse unmatched / unconfirmed / stale-health releases — without spending keys?

## Approach

1. Inspect `WalletRead` (docs.rs 0.24.0) and `ReceivedTransactionOutput` source. Do not invent SDK methods.
2. Write the unmatched-output contract test first (TDD RED), then the reducer.
3. Map the selected backend onto replayable snapshots rather than a live-only cursor.
4. Encode ZIP-321 from the ZIP (testnet shielded only). Refuse transparent and mainnet.
5. Live zakura/regtest: unmatched equal-amount to the wrong UA must fail before destination matching is implemented.

## Selected backend

| Role | Choice | License | Caveat |
|---|---|---|---|
| Scanner | `zcash_client_backend` 0.24.0 + `zcash_client_sqlite` 0.22.0 | MIT OR Apache-2.0 | sqlite crate security disclaimer: beta, not externally audited, actively changing. Viewing-only via UFVK import; do not load spending keys into fulfillment. |
| Payment URI | `zip321` 0.9.0 (reference) + this spike encoder | MIT OR Apache-2.0 | Encoder proven against the public ZIP-321 example, not against a real wallet. |
| Buyer wallet (intended) | Zashi / Zodl (ZIP-321) | MIT (wallet project) | **Not installed here.** Memo/receiver preservation was not observed. Zingo documents testnet; also not installed. |
| Rejected | `zecscope-scanner` 0.1.0 | MIT | Prototype wrapper on older crates. Existence is not production safety. |

## Attribution

**Random memo** (`invoice.attributionRef` ↔ `WalletRead::get_memo(NoteId)`).

Per-invoice shielded destinations were **not** selected: `ReceivedTransactionOutput` has no recipient address; `find_account_for_address` maps to an account, not an invoice. Amount-only matching is forbidden and tested.

Stable output id: `txid:pool:outputIndex` from the `get_received_outputs` txid context plus `pool_type()` and `output_index()`. Txid alone is not unique.

## Scanner mapping

| Application | Documented backend |
|---|---|
| `ChainRevision.height` | `WalletRead::chain_height` / `block_fully_scanned` |
| `ChainRevision.id` | `WalletRead::get_block_hash` / `get_max_height_hash` |
| `ScanHealth.caughtUp` | fully scanned height equals chain height and `suggest_scan_ranges` has no `Verify` gap |
| `Observation.amountZat` | `ReceivedTransactionOutput::value` |
| `Observation.confirmations` | `get_received_outputs(..., confirmations_policy)` / `confirmations_until_spendable` |
| Memo | `WalletRead::get_memo(NoteId)` |
| Mined height | `WalletRead::get_tx_height` |
| Enumerate receipts | **Gap:** `get_received_outputs` requires a txid. Adapter must snapshot `scan_cached_blocks` results and/or sqlite received-note rows, then replay from `ScanCheckpoint`. |

Seller-owned `ScanCheckpoint` advances only after `commitReconciliation`. Crash-before-commit and payment-while-stopped are proven against the snapshot adapter (not a live lightwalletd).

## Policies (configuration, not a risk-free claim)

- Network: `test` only
- `minConfirmations`: 10 (zero-conf release is rejected)
- `maxHealthAgeMs`: 120000
- Invoice expiry: 86400000 ms; late receipts get `late` and do not fulfill
- `healthy=true` with `caughtUp=false`, stale health, or a revision that does not cover the receipt cannot authorize release
- Non-canonical later updates replace chain state for the same `outputId` (synthetic reorg tests)

## Wallet URI / QR

ZIP-321 encoder matches the public shielded example in ZIP-321. No QR render and no wallet open were observed in this environment.

## Rerun

```bash
cd spikes/payments
node --experimental-strip-types --test tests/*.test.ts
```

Requires Node 26+ (type stripping). No extra packages. Live tests need a running thus-spoke-zakura 0.2.1 (`ths status --json`). Do not start or stop the stack from this spike. `ZAKURA_DASHBOARD` defaults to `http://127.0.0.1:32771`.

## Live settlement (zakura/regtest)

**Observed.** Fully shielded Orchard faucet payments on thus-spoke-zakura 0.2.1 / zakuracore/zakura 1.4.0. `node.chain` is `test`; `network` is `Regtest`. Not public testnet.

- TDD: amount-only live attribution released an equal-amount payment to a different UA (`invoiceId` set). Destination matching then refused that payment and released only the invoice UA.
- Probe `minConfirmations`: 1 (app default remains 10). Auto-mine on; extra blocks still increased confirmations.
- Dashboard faucet accepts a memo; CLI `ths faucet` does not. Memo text is not logged.
- GET `/accounts` omitted UFVK. WalletRead was not wired (no invented SDK). Receipts mapped through dashboard status/activity/transaction JSON onto `Observation` / `ScanHealth` / `ChainRevision`.
- Output id uses `txid:orchard:0` because orchard faucet txs are padded; `WalletRead::output_index` was not available.

## Verdict: PASS (zakura/regtest only)

### What worked
- Unmatched-output contract: RED (`releaseEligible true !== false`) then GREEN.
- 18 deterministic tests plus 2 live zakura tests.
- Live shielded receipt to the invoice UA released; equal amount to another account UA did not.
- Honest WalletRead mapping, including the enumerate-history and live-wiring gaps.

### What didn't
- No public testnet receipt.
- No ZIP-321 wallet QR/open. Encoder still rejects `uregtest1` (testnet `utest1` only).
- No UFVK + lightwalletd compact-block scan from this TypeScript spike.

### Surprises
- `ReceivedTransactionOutput` does not store txid or recipient; identity and attribution must be assembled by the adapter.
- `WalletRead` is not a receipt stream.
- Dashboard `to_account` maps to a UA, which WalletRead received-output fields do not.

### Recommendation for the real build
Keep random-memo as the WalletRead-compatible path. Live zakura destination-UA matching is dashboard-wallet evidence, not a WalletRead recipient field. Wire a UFVK-only scanner process before treating compact-block viewing as proven.
