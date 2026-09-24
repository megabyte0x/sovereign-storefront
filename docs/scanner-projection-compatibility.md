# Scanner wallet projection compatibility

## Pinned compatibility boundary

The scanner supports only the lock-resolved `zakura-client-sqlite 0.1.0-rc5` wallet schema (with `zakura-client-backend 0.1.0-rc5` and `zakura-keys 1.2.0`). This is not a general wallet SQLite API.

Lockfile registry checksums: `zakura-client-sqlite` `4757a07d2fcc344aa2bbec9ba4d68d95d09ed9968b1d3032f0ca348487f251af`; `zakura-client-backend` `ad892817774c836ab37239af03840b17368a4c5ed364f9ee868273bb0ddf0ada`; `zakura-keys` `5f301a02dd34dbc50d9ceb59b552501b73f74c47a137f58eba59c9415febf2bd`; `zakura-primitives` `f6d512f69295e815987e4c2802da5a3f37fa86418acca9e35d75f3ba8dc34a5d`.

Production enables backend `orchard`, `sync`, `lightwalletd-tonic-transport`, and `lightwalletd-tonic-tls-webpki-roots`; SQLite `orchard`; keys `orchard`; and the direct `zakura-primitives 1.2.0` parser with `default-features = false, features = ["std"]`. `test-dependencies` is dev-dependency-only and is not enabled in the production scanner dependency declaration.

`services/scanner/src/projection.rs` is the only runtime source file that opens wallet-owned SQLite. It uses `SQLITE_OPEN_READ_ONLY` plus connection-local `PRAGMA query_only = ON`; scanner-owned allocation and snapshot data uses `scanner.sqlite`, not `wallet.sqlite`.

The projection rejects the wallet as unavailable unless these migrated objects and columns exist:

| Object | Required columns / role |
| --- | --- |
| `v_received_outputs` | `id_within_pool_table`, `transaction_id`, `pool`, `output_index`, `account_id`, `value`, `address_id` |
| `transactions` | `id_tx`, `txid`, `block`, `mined_height`, `min_observed_height` |
| `accounts` | `id`, `uuid` |
| `orchard_received_notes` | ownership scope and composite Orchard output identity |
| `addresses` | account, key scope, encoded unified address |
| `blocks` | scanned block height/hash |
| `orchard_received_note_spends` | spent-history relationship |

The locked library-migrated fixture establishes `v_received_outputs` as a
SQLite `view` and every other declared object above as a SQLite `table`.
A same-name object with a different kind is schema drift and makes the
projection unavailable.

It also requires these library migration identifiers, checked from `schemer_migrations` as 16-byte values:

- `ee89ed2bc1c2421e9e98c1e3e54a7fc2` (`receiving_key_scopes`)
- `6d02ec7687204cc6b646c4e2ce69221c` (`full_account_ids`)
- `51d7a273aa194109932580e4a5545048` (`orchard_received_notes`)

## Projection contract

For the selected account, the projection reads only Orchard received rows (`v_received_outputs.pool = 3`) and uses the following documented, version-coupled joins:

1. `v_received_outputs.transaction_id → transactions.id_tx` preserves transaction identity and scanned/mined state.
2. `v_received_outputs` composite output identity joins `orchard_received_notes` by received-note id, transaction id, action index, and account id.
3. `v_received_outputs.address_id → addresses.id` verifies a derived external receiver, its external key scope, and that `addresses.account_id` equals the selected received-output account.
4. `transactions.block → blocks.height` supplies scanned canonical block hash.
5. `orchard_received_notes.id → orchard_received_note_spends.orchard_received_note_id` retains spent received history.

A received Orchard candidate is published only if the note scope and address scope both resolve to external and the library-decoded unified address contains an Orchard receiver. Any unresolved or conflicting external candidate fails the complete projection rather than producing a partial history. Internal/change rows are excluded. Spent received rows remain in historical output identity.

A mined receipt requires a matching scanned block link, mined height, and block hash. Retrieved/unscanned rows are retained with no canonical mining evidence. Scanner-owned snapshots later gate `complete=true` on both catch-up and transaction-enhancement barriers; no wallet table is written by the scanner projection.

## Compatibility validation and upgrade procedure

Tests create disposable databases through the locked wallet library migration/import/address APIs, then use deterministic fixture-only inserts to exercise the resulting migrated schema. They cover retained spent history, restart-stable first-seen timestamps, external-scope reconciliation failure, and retrieved/unscanned non-canonical output state.

Before changing the locked wallet package or its migration graph:

1. Update the pinned dependency deliberately and inspect the library migration and view definitions.
2. Update this document and `projection.rs` object/migration checks only after validating the replacement joins against a library-migrated disposable database.
3. Run the projection, snapshot, daemon, and adapter test suites. Any unknown/missing migration, object, or column must continue to fail closed.
4. Do not add generic fallback SQL, TypeScript wallet queries, or writes to wallet-owned tables.

This compatibility evidence is fixture-level only. It is not live-chain proof.

## Executed deterministic evidence

- RED (allocation): `cargo test --locked --manifest-path services/scanner/Cargo.toml --test wallet_persistence` initially failed at `wallet address derivation failed` when the journal stored an ordinal `u64` rather than the library-returned valid diversifier index. The repaired path reserves a valid external address through `WalletWrite::get_next_available_address`, journals the exact 11-byte index, and retries through `get_address_for_index`.
- RED (rewind fixture): `cargo test --locked --manifest-path services/scanner/Cargo.toml --test projection wallet_library_rewind_retains_output_identity_but_revokes_canonical_receipt -- --exact --nocapture` initially returned the pinned library error `RequestedRewindInvalid { safe_rewind_height: None, requested_height: BlockHeight(99) }`. The disposable fixture was then given a retained pre-receipt block and the library rewind target was made valid; no runtime wallet table was changed.
- GREEN schema/history: `cargo test --locked --manifest-path services/scanner/Cargo.toml --test projection` passed 6 migrated-wallet projection tests, including schema drift, scope/ownership selection, retained spent history, external reconciliation failure, retrieved height without canonical evidence, and library rewind plus same-height fork revocation.
- GREEN daemon/allocation boundary: `cargo test --locked --manifest-path services/scanner/Cargo.toml --test allocation --test api --test wallet_persistence` passed 6 tests. `init-view --config` is fail-closed without a complete private runtime configuration.
- GREEN foundation correction: `cargo test --locked --manifest-path services/scanner/Cargo.toml --test cli --test socket --test lease --test config_security -- --nocapture` passed 21 deterministic tests. They exercise immutable operator-attested birthday state (including hash/frontier/state tampering), pre-artifact UFVK rejection, HTTP/1.1 Content-Length framing, bounded stalled-peer isolation, private stale-socket recovery, unsafe socket-entry refusal, and active `serve` lifecycle lease exclusion for `init-view` and every retained `qualify` stage. `cargo check --locked --manifest-path services/scanner/Cargo.toml`, `cargo clippy --locked --manifest-path services/scanner/Cargo.toml --lib -- -D warnings`, and the same selected targets under Clippy passed. Broad `--all-targets` verification remains blocked by separate pending C1 test imports, so this is not a full-suite claim.
- Adapter fixture verification: `npx vitest run tests/unit/wallet-scanner.test.ts` passed 2 tests against a test-local Unix socket responder; `npm run typecheck` passed.

No `serve` plus TypeScript-adapter proof was executed because no safely configured, owned local private runtime configuration and lightwalletd resource were available in this worktree. The adapter fixture result is not a daemon or live-chain claim.

## Full-transaction parser groundwork

The scanner declares the same lock-resolved `zakura-primitives 1.2.0` that the pinned backend already uses, so enhancement code can parse `RawTransaction.data` before calling the wallet library. It does not import PCZT or any spending API.

- `transaction_status_from_raw_height` maps lightwalletd's `0` (mempool) and `u64::MAX` (fork) sentinels to `NotInMainChain`, rejects heights outside `u32`, and therefore cannot truncate an unrepresentable wire height into a canonical block.
- `parse_raw_transaction` uses `Transaction::read` with the branch active at the validated mined height, or at the caller's observed tip for non-canonical responses. Malformed full-transaction bytes are rejected before a wallet mutation.
- RED/GREEN: the status test first failed because the conversion did not exist; the malformed-payload test first failed because the parse seam did not exist. Both passed after implementation.
- Full deterministic verification: `cargo test --locked --manifest-path services/scanner/Cargo.toml`, `cargo check --locked --manifest-path services/scanner/Cargo.toml`, `cargo clippy --locked --manifest-path services/scanner/Cargo.toml -- -D warnings`, `cargo fmt --check --manifest-path services/scanner/Cargo.toml`, and `git diff --check` exited `0`.

## Enhancement and persistent-lifecycle deterministic evidence

The daemon now owns one shared, mutex-serialized view-only `WalletDb` capability for compact-block synchronization, full-transaction enhancement, coherent projection, and allocation derivation. `serve` starts a bounded retry worker that connects to configured lightwalletd, runs the pinned `sync::run`, obtains the current tip for non-canonical transaction parsing, resolves every authoritative `transaction_data_requests` entry with bounded `GetTransaction`, calls `decrypt_and_store_transaction`, persists the resulting status, and publishes only if its before/after remote tips agree. A failed pass revokes the last ready snapshot before retrying with capped backoff.

- `TxFilter.hash` is built from raw protocol TxId bytes, never reverse-hex display text.
- A lightwalletd `NotFound` response becomes the pinned `TxidNotRecognized` wallet status. Other RPC failures or malformed/identity-mismatched payloads fail the pass without publishing ready evidence.
- Test-only RC5 `test-dependencies` features are enabled only in `[dev-dependencies]`; the lockfile was resolved offline. They construct a mock-proved, fixture-only Orchard payment and do not change normal scanner dependency features or import spending code in production.
- RED/GREEN: `wallet::tests::real_wallet_enhancement_decrypts_a_fixture_payment_and_survives_reopen` first exposed RC5 fixture-surface mismatches, then passed after using its `AddressType::DefaultExternal` selector and `NonEmpty.head` field. It funds an RC5 fixture wallet, creates a payment to its own UFVK, serializes it as a `RawTransaction`, enhances a separate file-backed view-only scanner `WalletDb`, and verifies the target transaction remains present after reopening.
- Full deterministic verification after this slice passed: `cargo test --locked --manifest-path services/scanner/Cargo.toml` (**47** library tests plus integration suites), `cargo check --locked --manifest-path services/scanner/Cargo.toml`, `cargo clippy --locked --manifest-path services/scanner/Cargo.toml -- -D warnings`, `cargo fmt --check --manifest-path services/scanner/Cargo.toml`, and `git diff --check`.

This is deterministic fixture evidence, not chain-backed proof by itself. See "Owned live daemon/adapter and chain-reorg evidence" below for the live-chain proof and its one disclosed open limitation.

## Owned live daemon/adapter and chain-reorg evidence (2026-09-24)

All work below used owned, disposable local regtest/lightwalletd/`serve` instances started and torn down within this session. No key, address, transaction ID beyond the sanitized identifiers below, or endpoint value was retained past teardown; no historic instance was reused.

### Live `serve` + TypeScript adapter proof — achieved

- Added `scripts/provision-scanner-runtime.ts` and `services/scanner`'s `inspect-lightwalletd` CLI subcommand to derive and atomically write (mode 0600) a private runtime config from an owned node RPC and lightwalletd endpoint, cross-checking activation schedule and lightwalletd consensus before trusting anything.
- Started a fresh owned regtest/lightwalletd stack, ran the provisioner, `init-view` (fresh disposable UFVK), then `serve`.
- Found and fixed two real bugs surfaced only by this live run (neither caught by the deterministic fixture suite above, because its test doubles used values that only matched by construction): (1) `LifecycleWorker::run_forever`'s Tokio runtime was missing `.enable_io()`, silently panicking the worker thread on the first live gRPC call while the process kept running and holding the writer lease; (2) `src/adapters/wallet-scanner.ts`'s `validatePaymentUri` compared a ZIP-321 URI's decimal-ZEC `amount=` against raw zatoshis as a literal string, which only matched by degenerate accident. Both fixed; regression tests added (`services/scanner/src/daemon.rs`, `src/adapters/wallet-scanner.ts`, `tests/unit/wallet-scanner.test.ts`).
- With both fixes: allocated a receiver through the TypeScript adapter over the real Unix socket, funded it via `ths faucet` (0.0015 ZEC / 150000 zat), mined past the 10-confirmation eligibility boundary. The persistent daemon scanned, enhanced, and published the receipt with no external trigger. The adapter-verified snapshot showed exactly 1 receipt: `amountZat: "150000"`, `canonical: true`, `mined.height: 105`, matching txid `1f3f525788fcaf95ed1f9d7283531398f04b9edf441069e28e2808d0f1b87c6c`.
- Restart durability: sent `SIGTERM` (clean shutdown) to `serve`, restarted against the same config, re-queried through the adapter — identical txid/amount/height returned.
- Full deterministic verification after all fixes: `cargo fmt`, `cargo test --locked` (**84** tests across `services/scanner`), `cargo check --locked`, `cargo clippy --locked -- -D warnings`, `cargo fmt --check`, `git diff --check` — all exit 0. `npm run test` (152 tests / 22 files), `npm run typecheck`, `npm run build` — all exit 0.

### Live chain-reorg proof — a real, disclosed, open limitation

- Repeated the funding proof on a second disposable owned stack, then used node RPC `invalidateblock` directly on the exact block hash that had mined the confirmed receipt, confirmed via `getblockchaininfo` the tip dropped, and re-mined a genuinely different chain from that height (confirmed via `getblock`/`gettransaction`: the new block at that height shares no transactions with the original).
- **Finding:** while the replacement chain's tip stays at or below the wallet's pre-reorg max-scanned height, the scanner's published snapshot keeps reporting the orphaned receipt as `canonical: true`. Root cause, read directly from the pinned `zakura-client-sqlite`/`zakura-client-backend` 0.1.0-rc5 sources: the library's own `update_chain_tip` intentionally no-ops on height comparison alone whenever the observed tip has not yet exceeded the last-scanned height, by design deferring reorg detection to a continuity-error check that only fires once forward scanning resumes past that height. This is a bounded blind window, not permanent: once the replacement chain exceeds the old max-scanned height, the library's own continuity-error handling is expected to rewind and rescan (source-verified; not yet confirmed by a live run that continued past that point).
- **Decision (user, 2026-09-24): leave unfixed for now.** No scanner code was changed in response to this finding. Full detail, exact source line references, and the three remediation options considered (none implemented) are recorded in `.superpowers/sdd/2026-09-23-live-mvp-integration/task-3-report.md` under "Live chain-reorg proof — found a real correctness defect."
- Both reorg-test stacks were torn down (`ths stop`, confirmed via `docker ps`/`ths list --json`); no leftover containers or private runtime material remained.

This live evidence is chain-backed for the funding/restart-durability claims above; the reorg-detection gap is a disclosed, reproduced, currently-accepted limitation, not resolved by this evidence.

