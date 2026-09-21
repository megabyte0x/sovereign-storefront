# Gate C spike: Zcash scanner, invoice attribution, wallet handoff

Deterministic probe of the application `Scanner` / `ScanCheckpoint` / `ChainRevision` contract against documented `zcash_client_backend` 0.24.0 `WalletRead` APIs and ZIP-321. Live shielded testnet settlement was **not** executed.

## Question

Can a viewing-only Zcash scanner attribute a shielded payment to one invoice, replay from a seller-owned checkpoint, and refuse unmatched / unconfirmed / stale-health releases — without spending keys?

## Approach

1. Inspect `WalletRead` (docs.rs 0.24.0) and `ReceivedTransactionOutput` source. Do not invent SDK methods.
2. Write the unmatched-output contract test first (TDD RED), then the reducer.
3. Map the selected backend onto replayable snapshots rather than a live-only cursor.
4. Encode ZIP-321 from the ZIP (testnet shielded only). Refuse transparent and mainnet.
5. Attempt live testnet payment only if viewing capability, compatible wallet, and test funds exist.

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

Requires Node 26+ (type stripping). No extra packages.

## Live settlement

**BLOCKED.** This host has no zcashd/lightwalletd/zebrad, no testnet funds, no UFVK/viewing-only wallet data, and no Zashi/Zingo/YWallet binary. No fake txids were recorded.

## Verdict: PARTIAL

### What worked
- Unmatched-output contract: RED (`releaseEligible true !== false`) then GREEN.
- 18 deterministic tests: attribution, checkpoint replay, health/revision gates, synthetic reorg, ZIP-321 testnet-only encoding.
- Honest WalletRead mapping, including the enumerate-history gap.

### What didn't
- No real shielded testnet receipt.
- No wallet memo/receiver preservation check.
- No viewing-only scan against compact blocks.

### Surprises
- `ReceivedTransactionOutput` does not store txid or recipient; identity and attribution must be assembled by the adapter.
- `WalletRead` is not a receipt stream.

### Recommendation for the real build
Keep random-memo attribution until a WalletWrite/sqlite probe proves per-invoice destination mapping. Do not treat this spike as Gate C pass. Unblock with testnet TAZ, a UFVK-only scanner process, and one installed ZIP-321 wallet.
