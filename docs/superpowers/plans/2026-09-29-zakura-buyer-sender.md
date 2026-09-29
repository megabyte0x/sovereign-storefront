# Zakura Buyer Sender Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **User direction (2026-09-29):** implement option 2 from the zingo-cli incident review. Do not interleave test cases with development: Tasks 1–5 build the feature, Task 6 writes every test, Task 7 runs the live verification.

**Goal:** Replace zingo-cli (and with it Nym, the local zingolib patch, the two build variants and text parsing) as the T01 buyer wallet with a small Rust sender built on the Zakura Common / Zakura wallet crates the seller scanner already pins. Make every send idempotent and self-resolving so a failed broadcast never needs the manual expire-and-reset routine.

**Architecture:** A new crate `tools/buyer-sender` builds the binary `ssf-buyer-sender`. It depends by path on the scanner library (`services/scanner`) for the testnet parameters (`ScannerParams`), the private-directory helpers (`PrivateDir`) and the compact block cache (`PersistentBlockCache`), and uses the same pinned `zakura-client-backend` / `zakura-client-sqlite` rc5 family for sync, proposal, signing and broadcast. The order is: build and sign, persist the raw transaction and expiry height, then broadcast directly to `testnet.zec.rocks`. Status comes from `GetTransaction` plus the chain tip. `scripts/public-t01-wallet.ts` keeps its caps and ledger but calls the new binary through a stable JSON contract. Pending sends are resolved automatically: mined → `sent`, not found past expiry → `expired`, otherwise the same bytes are rebroadcast.

**Tech Stack:** Rust 1.91+, edition 2024; `zakura-client-backend =0.1.0-rc5` (features `orchard`, `sync`, `lightwalletd-tonic-transport`, `lightwalletd-tonic-tls-webpki-roots`); `zakura-client-sqlite =0.1.0-rc5`; `zakura-keys =1.2.0`; `zakura-primitives =1.2.0`; `zakura-proofs =1.2.0` (`bundled-prover`); `zip321 =0.9.0`; `bip39 =2.2.2`; `tokio`/`tonic` at the scanner's pins. Node 22 TypeScript scripts (`node --experimental-strip-types`), vitest.

**Spec:** the incident review and option analysis in this session: zingo-cli bugs 1–8, with option 2 chosen. Context: `docs/superpowers/plans/2026-09-26-public-testnet-hosting/README.md`, ledger rows 5.2a–5.2f.

## Why each zingo-cli problem goes away

| zingo-cli problem | Resolution in this plan |
|---|---|
| 1. v5 predates NU6.3 | The same rc5 family already syncs post-NU6.3 testnet in the scanner, including Ironwood notes |
| 2. Nym-only online mode / test-only clearnet build | Plain gRPC over TLS to `https://testnet.zec.rocks:443`, the same endpoint and trust boundary as the scanner |
| 3. Slow, flaky relays per command | No proxy; one channel per command with explicit deadlines |
| 4. Mainnet `DESTINATION_INDEXERS` | No destination list: `SendTransaction` goes to the configured testnet server only; mainnet params are not constructible (`ScannerParams`) |
| 5. Nym timeouts after the patch | Direct send; a timeout is resolved by status plus rebroadcast of identical bytes |
| 6. Payment limbo, manual expiry | txid, raw bytes and expiry height are persisted **before** broadcast; `resolve` makes the mined/expired decision from chain data automatically; expiry delta shortened to 20 blocks |
| 7. Dependence on an upstream "never use" mode | Gone |
| 8. Pinned fork, patch, two builds, text parsing, Ironwood | One crate on the scanner's pins and lockfile; JSON output we define; balances report `orchard` and `ironwood` explicitly |

## Zakura Common reuse (and one deliberate exception)

- **Reused as is:** `zakura-client-backend` (`sync::run`, `propose_standard_transfer_to_address`, `create_proposed_transactions`, `SpendingKeys`, lightwalletd `CompactTxStreamerClient`), `zakura-client-sqlite` (`WalletDb`, `init_wallet_db`, `import_account_hd`), `zakura-keys` (`UnifiedSpendingKey::from_seed`), `zakura-primitives` (`Transaction::write`, `DEFAULT_TX_EXPIRY_DELTA`), `zakura-proofs` (`LocalTxProver::bundled()`), and `start_orchard_proving_key_warmup` (rc5 `lib.rs:94`).
- **Reused from our scanner library:** `config::ScannerParams::test_network()`, `private_fs::PrivateDir`, `cache::PersistentBlockCache`, `scan::within_deadline`, `scan::SYNC_DEADLINE`/`GRPC_*_DEADLINE`.
- **Not used yet:** `zakura-transaction-status 0.0.1-rc0` (zakura-core/wallet-libraries). It depends on `zakura-client-backend 0.1.0-rc7` and the 2.0 crypto family, which would put a second copy of the crypto stack into the binary alongside the scanner's rc5 pins. The sender mirrors its decode rules exactly: only gRPC `NOT_FOUND` means absent, `height 0` means mempool, `u64::MAX` means forked, and the txid must match the payload. Moving scanner and sender to rc7 together, then swapping in the crate, is a follow-up (Task 7, last step).

## Global Constraints

- Testnet only. The binary accepts no network flag; parameters are always `ScannerParams::test_network()` and the endpoint must pass `config::validate_lightwalletd_endpoint`. Default endpoint `https://testnet.zec.rocks:443`.
- Caps unchanged: `MAX_SENDS = 2`, `MAX_INVOICE_ZAT = 1_000_000`, `FEE_RESERVE_ZAT = 100_000`. Only `utest1` unified receivers, one payment, optional memo.
- Nothing the binary or script prints may contain a seed, spending key, UFVK, receiver, ZIP-321 URI or raw transaction. Allowed output: txid, heights, zatoshi amounts, pool names, state words, fixed error strings (`&'static str`, scanner style).
- Private state lives in `~/.local/state/ssf-buyer/` (mode 0700): `seed.private` (0600), `wallet.sqlite` (0600), `blocks/` (block cache), `attempts/<invoiceDigest>.json` (0600). Nothing goes under the repo tree, and nothing is added to git.
- One wallet process at a time: the sender takes an exclusive `flock` on `~/.local/state/ssf-buyer/lock` for every command. zingo-cli is retired for this seed once `import` succeeds; never run both against the same funds.
- A second, different transaction for an invoice is never built while that invoice has an unresolved attempt. Only the identical bytes are rebroadcast.
- Do not touch the running T01 runner, `buyer-sends.json`, `t01-run.json` or `.runtime/public/buyer-wallet/` until purchase A is recorded `sent` and the runner has exited.
- Grants: no commits per task (commit only at the plan's end, and only if the user asks), no push, no paid resources. Conventional Commits if a commit is requested.
- Scripts must load under `node --experimental-strip-types`: no enums and no constructor parameter properties.

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `tools/buyer-sender/Cargo.toml` | create | Crate manifest, pins copied from `services/scanner/Cargo.toml`, path dep on the scanner lib |
| `tools/buyer-sender/Cargo.lock` | create | Seeded from `services/scanner/Cargo.lock` so shared crates keep identical versions |
| `tools/buyer-sender/src/main.rs` | create | Argument parsing, lock, dispatch, JSON output, exit codes |
| `tools/buyer-sender/src/state.rs` | create | State dir layout, seed file, wallet open/init, attempt-file read/write |
| `tools/buyer-sender/src/chain.rs` | create | lightwalletd client, sync, tip, broadcast, tx status decode |
| `tools/buyer-sender/src/pay.rs` | create | ZIP-321 validation, proposal, signing, persist-then-broadcast |
| `scripts/public-t01-wallet.ts` | modify | Replace the zingo runner with the sender contract; add `resolve`; automatic pending resolution |
| `scripts/public-t01-live.ts` | modify | `walletSend` resolves ambiguous sends with a bounded poll before reporting |
| `scripts/public-t01.ts` | modify | `WALLET_NAME`/`WALLET_VERSION` report the new sender |
| `package.json` | modify | `build:buyer-sender` script |
| `docs/superpowers/plans/2026-09-26-public-testnet-hosting/README.md` | modify | Ledger row and the 5.2 sender description |
| `tests/unit/public-t01-wallet.test.ts`, `tests/unit/public-t01.test.ts` | modify (Task 6 only) | New contract |
| `tools/buyer-sender/src/*` `#[cfg(test)]` modules | add (Task 6 only) | Pure-function tests |

## Binary contract (frozen; Tasks 4–6 depend on it)

```
ssf-buyer-sender [--state-dir DIR] [--lightwalletd URL] <command>

  import --mnemonic-file F --birthday H        # once; copies seed into state, creates wallet, first sync
  status                                       # sync, then balances
  pay --uri-file F --attempt-id ID [--expiry-delta N]   # N in 10..=40, default 20
  tx-status --attempt-id ID                    # status of a recorded attempt
  rebroadcast --attempt-id ID                  # resend the recorded bytes, same txid
```

- The URI is passed as a 0600 file path, never on argv, so it doesn't show up in `ps`. `ID` is the invoice digest (`sha256(uri)` hex, 64 chars), which the TS ledger already computes.
- stdout: exactly one JSON object per invocation.
  - `import`: `{"ok":true,"birthday":H,"tip":T}`
  - `status`: `{"network":"test","tip":T,"spendableZat":"…","orchardZat":"…","ironwoodZat":"…"}`
  - `pay`: `{"attemptId":ID,"txid":"<64 hex>","targetHeight":T,"expiryHeight":E,"broadcast":"accepted"|"rejected"|"unknown"}`
  - `tx-status`: `{"attemptId":ID,"txid":…,"state":"mined"|"mempool"|"not_found"|"expired"|"forked","minedHeight":H|null,"tip":T,"expiryHeight":E}`
  - `rebroadcast`: same shape as `pay`.
  - errors: `{"error":"<fixed string>"}`
- txid is printed in the display (byte-reversed) order, which is what `sameTxid` in `scripts/public-t01.ts` already accepts.
- Exit codes:
  - `0`: success.
  - `2`: refused before anything was signed. The attempt file is absent. Safe to fix and retry.
  - `3`: an attempt file exists but the broadcast outcome is unknown. The caller must resolve it, never pay again.
  - `4`: the attempt already exists. `pay` refuses to build, prints the recorded attempt, and the caller resolves.
- `expired` is reported only when gRPC `NOT_FOUND` was returned **and** `tip > expiryHeight`. Any transport error is an error, never `not_found`.

---

### Task 1: Crate scaffold and state layer

**Files:** create `tools/buyer-sender/Cargo.toml`, `tools/buyer-sender/src/main.rs`, `tools/buyer-sender/src/state.rs`; seed `tools/buyer-sender/Cargo.lock`; modify `package.json`.

- [ ] **1.1 Manifest.** Package `ssf-buyer-sender`, `edition = "2024"`, `rust-version = "1.91"`, `[[bin]] name = "ssf-buyer-sender"`. Copy these dependency lines verbatim from `services/scanner/Cargo.toml`, with the same package renames and exact pins: `zcash_client_backend` (add nothing beyond its existing features), `zcash_client_sqlite`, `zakura_pczt` (feature unification, as the scanner comments), `zcash_keys`, `zcash_primitives`, `zcash_protocol`, `zcash_address`, `zip32`, `zip321`, `tokio`, `tonic`, `prost`, `rusqlite`, `serde`, `serde_json`, `hex`, `sha2`, `getrandom`, `rand_core`, `nix` (add feature `fs` if missing). Add:
  ```toml
  sovereign-storefront-scanner = { path = "../../services/scanner" }
  zcash_proofs = { package = "zakura-proofs", version = "=1.2.0", default-features = false, features = ["bundled-prover", "multicore"] }
  orchard = { package = "zakura-orchard", version = "=1.2.0", default-features = false }
  bip39 = { version = "=2.2.2", default-features = false, features = ["std"] }
  secrecy = "=0.8.0"
  zeroize = "=1.9.0"
  ```
  Check each added version against `services/scanner/Cargo.lock` (`grep -A1 'name = "<crate>"'`): `zakura-proofs 1.2.0`, `zakura-orchard 1.2.0`, `secrecy 0.8.0` and `zeroize 1.9.0` are already there. If `bip39` is not, it is a leaf crate and adds no crypto-stack duplicate.
- [ ] **1.2 Lockfile.** `cp services/scanner/Cargo.lock tools/buyer-sender/Cargo.lock`, then run `cargo check --manifest-path tools/buyer-sender/Cargo.toml` once (without `--locked`) so Cargo only adds the missing entries. Do not run `cargo generate-lockfile` or `cargo update`: both re-resolve everything and can pull the 2.x crypto family. Then confirm `cargo tree --manifest-path tools/buyer-sender/Cargo.toml -d -e normal | grep -E '^(zakura|zcash|orchard|sapling|halo2)'` prints nothing: there must be no duplicate crypto family.
- [ ] **1.3 Scanner exports.** If any of `scan::within_deadline`, `scan::SYNC_DEADLINE`, `scan::GRPC_CONNECT_DEADLINE`, `scan::GRPC_RPC_DEADLINE`, `config::ScannerParams`, `config::validate_lightwalletd_endpoint`, `private_fs::PrivateDir`, `private_fs::private_parent` or `cache::PersistentBlockCache` is not `pub` from the scanner lib (`services/scanner/src/lib.rs`), make exactly that item `pub`. Change nothing else in the scanner.
- [ ] **1.4 `state.rs`.**
  - `StateDir::open_or_create(path)` creates `~/.local/state/ssf-buyer` (default; `--state-dir` overrides) with mode 0700 through `private_parent` + `PrivateDir::open_or_create_child`, and takes `flock(LOCK_EX | LOCK_NB)` on `lock`. If the lock is held it returns `"another sender process holds the wallet lock"`.
  - `write_seed(mnemonic_file)` reads the file (must be owned by the user and mode 0600, else refuse), parses it with `bip39::Mnemonic::parse_in(English, …)`, and stores the normalized phrase to `seed.private` via `PrivateDir::write_file_atomic`. `read_seed()` returns `SecretVec<u8>` from `mnemonic.to_seed("")`, zeroized on drop.
  - `open_wallet(params)` opens the wallet the same way as `scan.rs::open_wallet` (pre-create through `ensure_file`, then `WalletDb::for_path(proc_path, ScannerParams::test_network(), SystemClock, UnwrapErr(SysRng))`), then runs `init_wallet_db(&mut db, Some(seed))`. Type alias: `type Db = WalletDb<Connection, ScannerParams, SystemClock, UnwrapErr<SysRng>>`.
  - The `Attempt` struct is serde-serialized with fields `attempt_id`, `txid`, `raw_hex`, `target_height`, `expiry_height`, `amount_zat`, `created_at`. `write_attempt` uses `attempts/` + `write_file_atomic` with create-new semantics, and fails if the file exists. `read_attempt(id)` requires `id` to match `^[0-9a-f]{64}$`.
- [ ] **1.5 `main.rs` skeleton.** A hand-rolled parser in the scanner's `main.rs` style (no clap) for the frozen contract. Each command returns `Result<serde_json::Value, (u8, &'static str)>`. `main` prints the JSON or `{"error":…}` and returns the exit code. Set up a multi-thread tokio runtime.
- [ ] **1.6 Build script.** In `package.json` add `"build:buyer-sender": "cargo build --locked --release --manifest-path tools/buyer-sender/Cargo.toml"`, then run it once to confirm the crate compiles (stubs may return `"not implemented"`).

### Task 2: Chain access (`chain.rs`)

**Files:** create `tools/buyer-sender/src/chain.rs`.

- [ ] **2.1 Client.** `connect(endpoint)` validates with `validate_lightwalletd_endpoint`, then calls `CompactTxStreamerClient::connect` wrapped in `within_deadline(GRPC_CONNECT_DEADLINE, …)`, the same as `scan.rs:181`.
- [ ] **2.2 Tip.** `tip(client)` calls `get_latest_block(ChainSpec {})` under `GRPC_RPC_DEADLINE` and returns `BlockHeight`.
- [ ] **2.3 Sync.** `sync(client, db, cache, deadline)` calls `sync::run(&mut client, &params, &cache, &mut db, 100)` under `within_deadline(deadline, …)`. Use 30 minutes for `import`'s first sync and `SYNC_DEADLINE` (120 s) × 3 for the others. On timeout, return `"wallet synchronization timed out"`. Nothing has been signed at that point, so it exits with code 2.
- [ ] **2.4 Birthday.** `birthday_at(client, h)` calls `get_tree_state(BlockId { height: h - 1, hash: vec![] })` and then `AccountBirthday::from_treestate(tree, None)`, mirroring `scan.rs:360–369`.
- [ ] **2.5 Broadcast.** `broadcast(client, raw: &[u8]) -> Broadcast` calls `send_transaction(RawTransaction { data, height: 0 })` under `GRPC_RPC_DEADLINE`. `error_code == 0` maps to `Accepted`; a nonzero code maps to `Rejected`, and its `error_message` is discarded, never printed. A gRPC error or timeout maps to `Unknown`. A rejection doesn't prove the transaction is absent (for example "already in mempool"), so callers treat `Rejected` the same as `Unknown` for ledger purposes.
- [ ] **2.6 Status.** `tx_status(client, txid, expiry_height)` calls `get_transaction(TxFilter { block: None, index: 0, hash: txid bytes })` and applies the zakura-transaction-status rules:
  - `Ok(raw)`: decode with `Transaction::read(&raw.data[..], BranchId::Nu6_3 or the branch for raw.height)`. Require no trailing bytes and `txid()` equal to the request, else `"status payload is malformed"`. Then `height 0 → mempool`, `u64::MAX → forked`, `1..=u32::MAX → mined(h)`.
  - `Err(Code::NotFound)` → `not_found`, promoted to `expired` when `tip > expiry_height`.
  - Any other error → `Err("transaction status unavailable")`.

### Task 3: Import and status commands

**Files:** modify `tools/buyer-sender/src/main.rs`, `tools/buyer-sender/src/state.rs`.

- [ ] **3.1 `import`.** Refuse if `wallet.sqlite` already holds an account (`get_account_ids()` non-empty). Then `write_seed`, `open_wallet`, `connect`, `birthday_at(--birthday)`, and `db.import_account_hd("ssf-buyer", &seed, zip32::AccountId::ZERO, &birthday, None)`. ZIP-32 account 0 is the account zingolib uses, so the existing faucet funds are found. Then run the first sync (30 min deadline) and print `{"ok":true,"birthday":H,"tip":T}`.
- [ ] **3.2 Account lookup helper.** Derive `usk = UnifiedSpendingKey::from_seed(&params, seed, AccountId::ZERO)`, then `db.get_account_for_ufvk(&usk.to_unified_full_viewing_key())`. `None` means `"wallet account does not match the stored seed"`.
- [ ] **3.3 `status`.** Sync, then `db.get_wallet_summary(ConfirmationsPolicy::default())`. For the account read `spendable_value()`, `orchard_balance().spendable_value()` and `ironwood_balance().spendable_value()`, and print the status JSON. If the summary is `None` (the wallet is not yet synced), return `"wallet is not synchronized"` with exit 2.

### Task 4: Pay, tx-status and rebroadcast (`pay.rs`)

**Files:** create `tools/buyer-sender/src/pay.rs`; modify `main.rs`.

- [ ] **4.1 Attempt guard first.** If `attempts/<ID>.json` exists, print that attempt in the `pay` output shape with `"broadcast":"unknown"` and exit 4. Do not sync or build.
- [ ] **4.2 URI.** Read `--uri-file` (must be owned by the user and 0600), then `zip321::TransactionRequest::from_uri`. Require exactly one payment. Its recipient address must decode for `NetworkType::Test` as a unified address that can receive Orchard (`ZcashAddress::convert_if_network::<zcash_keys::address::Address>(NetworkType::Test)`), with amount in `1..=1_000_000` zat and at most one memo. Otherwise exit 2 with a fixed message. Check that `sha256(file bytes, trimmed)` equals `--attempt-id`, else `"attempt id does not match the invoice"`.
- [ ] **4.3 Sync and balance.** Sync. Require spendable ≥ amount + 100_000 (the same reserve as the script), else exit 2.
- [ ] **4.4 Propose.** Call `propose_standard_transfer_to_address(&mut db, &params, StandardFeeRule::Zip317, account_id, ConfirmationsPolicy::default(), &address, amount, memo, None, ShieldedPool::Orchard, None, None)`. Use Orchard as the fallback change pool: post-NU6.3, input selection moves change and the payment into Ironwood itself (see rc5 `wallet.rs:2235–2279`), so no pool logic is added here. Any error exits 2 with `"payment proposal failed"`.
- [ ] **4.5 Build and sign.** Call `start_orchard_proving_key_warmup` for the circuit version at the proposal's target height (as its doc comment requires), take `prover = LocalTxProver::bundled()`, `expiry = BlockHeight::from(proposal.min_target_height()) + delta` and `keys = SpendingKeys::from_unified_spending_key(usk)`, then run `create_proposed_transactions(&mut db, &params, &prover, &prover, &keys, OvkPolicy::Sender, &proposal, Some(expiry))`. Require exactly one txid, else exit 2 with `"proposal produced more than one transaction"`. The multi-step shape is not expected for a shielded-to-shielded payment, and the script's one-send accounting forbids it.
- [ ] **4.6 Persist before broadcast.** `db.get_transaction(txid)?` → `tx.write(&mut raw)`. Check `tx.expiry_height() == expiry`. Write the `Attempt` file. From here on every exit path is 0 or 3, never 2.
- [ ] **4.7 Broadcast.** `broadcast(raw)`. Print the `pay` JSON with `broadcast` set to `accepted`, `rejected` or `unknown`. Exit 0 on `accepted`, 3 otherwise.
- [ ] **4.8 `tx-status`.** Read the attempt, connect, get `tip`, run `tx_status`, and print. Exit 0 on a definite answer (`mined`, `mempool`, `not_found`, `expired`, `forked`) and 3 on `transaction status unavailable`.
- [ ] **4.9 `rebroadcast`.** Read the attempt. If `tip > expiry_height`, exit 2 with `"attempt has expired; nothing was sent"`, because a node would reject it anyway and this keeps state honest. Otherwise `broadcast(raw_hex bytes)` and print the `pay` shape.
- [ ] **4.10 Build.** Run `npm run build:buyer-sender`; zero warnings expected (`cargo build` with `-D warnings` via `RUSTFLAGS` once).

### Task 5: Wire the TypeScript runner and docs

**Files:** modify `scripts/public-t01-wallet.ts`, `scripts/public-t01-live.ts`, `scripts/public-t01.ts`, `docs/superpowers/plans/2026-09-26-public-testnet-hosting/README.md`.

- [ ] **5.1 Remove zingo plumbing** from `scripts/public-t01-wallet.ts`: `WalletTransport`, `walletTransport`, `walletBinary`, `walletArgs`, `SSF_BUYER_TRANSPORT`, the `quicksend`/`spendable_balance` handling, `jsonObject` (replaced by strict `JSON.parse` of the whole stdout), and the three-attempt balance retry. The balance read is now one direct gRPC call and doesn't need retrying. Update the header comment to describe the new sender.
- [ ] **5.2 Runner.** Change it to `SenderRunner = (args: readonly string[]) => Promise<{ code: number; stdout: string }>`. Default: spawn `tools/buyer-sender/target/release/ssf-buyer-sender` with `--lightwalletd LIGHTWALLETD`. Keep the redacted stderr append to `.runtime/public/wallet-stderr.log` (reuse `redactWalletText`).
- [ ] **5.3 Ledger shape.** Extend `SendRecord` with optional `txid`, `expiryHeight` and `resolvedBy?: 'chain' | 'manual'`. Existing records (4 `expired`, 1 `sent`) stay valid.
- [ ] **5.4 `send --uri`.** Parse (unchanged `parseTestnetZip321`) and apply the cap and duplicate checks as now. Write the URI to a 0600 temp file under `.runtime/public/` and delete it in `finally`. Write the `pending` record before invoking. Then `pay --uri-file … --attempt-id <digest>`:
  - exit 0 with `accepted`: record `status: 'sent'`, `txid` and `expiryHeight`.
  - exit 3, or exit 4: record `txid` and `expiryHeight` on the pending record, run `resolve` (5.5) for that record, and return 0 if it becomes `sent`. If it stays pending, return 3 with `UNRESOLVED: … will be resolved automatically; do not pay again`.
  - exit 2: remove the pending record (nothing was signed) and return 2 with the fixed message.
- [ ] **5.5 New `resolve` command and function** `resolvePending(ledger)`. For each `pending` record with a `txid`, run `tx-status`:
  - `mined` → `sent` (`resolvedBy: 'chain'`)
  - `expired` → `expired` (`resolvedBy: 'chain'`)
  - `not_found` or `forked` before expiry → `rebroadcast`, stay pending
  - `mempool` → stay pending
  - exit 3 → stay pending

  A pending record **without** a txid (legacy, or a crash before the attempt file existed) is looked up by `tx-status --attempt-id <digest>`. If no attempt file exists, it is removed, because nothing was signed. `send` calls `resolvePending` first, so a pending record no longer blocks new sends once it resolves. The rule "an unresolved record blocks new sends" stays for records that remain pending.
- [ ] **5.6 `status`.** Call the sender's `status`. Output keeps the existing keys (`network`, `spendableZat`, `sends`, `pending`, `remaining`) and adds `orchardZat`, `ironwoodZat` and `tip`, so `walletStatus()` in `public-t01-live.ts` keeps working.
- [ ] **5.7 `scripts/public-t01-live.ts` `walletSend`.** On code 3, poll `runPublicT01Wallet(['resolve'])` every 30 s for up to 15 minutes (well past the 20-block expiry only on a stalled chain, so the result is usually `sent` or still pending). Return `{kind:'sent', txid}` if it resolves to `sent`, else `{kind:'ambiguous'}`. The runner's existing "ambiguous is never resent" rule is unchanged.
- [ ] **5.8 `scripts/public-t01.ts`.** Set `WALLET_NAME = 'ssf-buyer-sender'` and `WALLET_VERSION` to `ssf-buyer-sender 0.1.0 (zakura-client-backend 0.1.0-rc5)`. Both are validated by `live-observe`'s regex `^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$` (and ≤128 chars for the version), so keep parentheses out of `WALLET_NAME`. The version string may contain them.
- [ ] **5.9 Smoke-load** each script: `node --experimental-strip-types -e "await import('./scripts/public-t01-wallet.ts'); await import('./scripts/public-t01-live.ts')"`.
- [ ] **5.10 Plan docs.** In the public-testnet README ledger, add a `5.2g buyer sender` row (status and evidence filled in during Task 7). In its 5.2 text, replace the zingo-cli wallet description with a pointer to this plan. Don't edit historical rows 5.2a–5.2f.

### Task 6: Tests (all test work for this plan)

**Files:** `tools/buyer-sender/src/{pay,chain,state}.rs` (`#[cfg(test)]`), `tests/unit/public-t01-wallet.test.ts`, `tests/unit/public-t01.test.ts`.

- [ ] **6.1 Rust unit tests** (`cargo test --locked --manifest-path tools/buyer-sender/Cargo.toml`):
  - URI validation: rejects a mainnet `u1…` receiver, two payments, zero or over-cap amount, and an attempt-id mismatch. Accepts a valid `utest1` fixture (derive one from a fixed test seed with `UnifiedSpendingKey::from_seed(&ScannerParams::test_network(), …)`).
  - Status decode: `NotFound` → `not_found`; `NotFound` with `tip > expiry` → `expired`; `Unavailable`, `DeadlineExceeded` → error, never `not_found`; height `0` / `u64::MAX` / `n`; wrong-txid payload → malformed.
  - Broadcast mapping: code 0 → accepted, nonzero → rejected, and the message is never included in output.
  - Attempt file: create-new refuses an existing file; mode 0600; `read_attempt` rejects a non-hex id.
  - `pay` guard: an existing attempt returns exit 4 before any sync (inject a client factory that panics if called).
  - Expiry delta bounds 10..=40.
  - Output hygiene: serialize every output struct from fixtures and assert no `utest1`, `uviewtest`, or 65+ hex run appears.
- [ ] **6.2 `tests/unit/public-t01-wallet.test.ts`:** rewrite the runner fake to the frozen JSON contract. Keep every existing refusal case (bad URI, repeated invoice, cap, balance). Add:
  - exit 2 removes the pending record
  - exit 3 then `tx-status mined` → `sent`
  - exit 3 then `expired` → `expired` without a manual edit, and a later send of the same invoice is allowed
  - `not_found` before expiry → rebroadcast is called once with the same attempt id and the record stays pending
  - a legacy pending record with no attempt file is removed
  - the URI never appears on argv (it is only in a file that is deleted afterwards)
  - the old zingo helpers (`walletBinary` and the rest) are removed

  Delete the `walletBinary`/transport tests.
- [ ] **6.3 `tests/unit/public-t01.test.ts`:** change the finalize assertion from `'zingo-cli'` to `'ssf-buyer-sender'`.
- [ ] **6.4 Gates:** `npx vitest run` (full, to a diag log), `npx tsc --noEmit`, `git diff --check`, `cargo clippy --locked --manifest-path tools/buyer-sender/Cargo.toml -- -D warnings`, and `cargo test --locked --manifest-path services/scanner/Cargo.toml` (the scanner is unchanged apart from any `pub` exports). Re-measure the vitest count; don't compare against an old baseline. If `build-provenance`/`log-secrecy` flake under load, re-run them alone.

### Task 7: Live verification and cut-over

Preconditions: purchase A is `sent` in `buyer-sends.json`, the T01 runner has exited, and no zingo-cli process is running (`ps -eo pid,args | grep zingo-cli | grep -v grep` is empty).

- [ ] **7.1 Seed file.** Inspect `.runtime/public/buyer-wallet/recovery-info.private` structurally only (line count and word count per line; never print values), extract the 24-word phrase and the birthday into a 0600 scratch file under `~/.local/state/`, and `shred -u` that file after import.
- [ ] **7.2 Import.** `ssf-buyer-sender import --mnemonic-file <f> --birthday <h>` succeeds.
- [ ] **7.3 Same keys, without printing any key.** Pipe zingo-cli's `export_ufvk` (clearnet build, one last read-only `--nosync` call) straight into `sha256sum`. Compare that against the sha256 of the UFVK derived from `seed.private`, computed by a scratch `examples/ufvk_digest.rs` that prints only the digest and is deleted afterwards. Don't add a digest command to the shipped binary. Record only "digests equal".
- [ ] **7.4 Balance parity.** `status` shows the post-purchase-A balance: 10,000,000 minus purchase A's amount and fee, in `ironwoodZat`. Record the numbers.
- [ ] **7.5 Speed check.** Record the wall time of `status` and of the build step in `pay` (proving on the ARM laptop). Expected: seconds.
- [ ] **7.6 Purchase B.** Run the T01 runner `run` for purchase B as normal. Expected: `pay` → `accepted`, the scanner and checker both see the receipt, and T01 continues to finalize.
- [ ] **7.7 Retire zingo.** Move `.runtime/public/tooling/zingolib-v6*` and `.runtime/public/buyer-wallet/` into a 0700 `.runtime/public/archive/zingo-<date>/`; don't delete them. Remove `SSF_BUYER_TRANSPORT` from any local env file. Ledger row 5.2g: `done`, with the evidence from 7.2–7.6.
- [ ] **7.8 Follow-ups to record, not do:**
  - File the zingolib `DESTINATION_INDEXERS` testnet bug with zingolabs. The draft goes to the user first, and it must not mention local file paths.
  - Move the scanner and sender together to `zakura-client-backend 0.1.0-rc7` and swap the hand-written status decode for `zakura-transaction-status`.
  - Optionally add a regtest round trip against zakura-regtest for the sender.

## Acceptance

| Requirement | Evidence |
|---|---|
| No Nym, no zingolib, no patch, no second build | `scripts/public-t01-wallet.ts` has no `zingo`/`nym`/`SSF_BUYER_TRANSPORT` (`grep -in`) |
| Testnet-only | No network flag; `ScannerParams::test_network()`; mainnet receiver rejected (6.1) |
| Persist before broadcast | Attempt file exists whenever exit is 0/3/4 (4.6, 6.1) |
| No manual expiry | `resolve` sets `expired` from chain data (5.5, 6.2) |
| Never a second transaction per invoice | Exit 4 guard plus pending-blocks rule (4.1, 5.5, 6.1, 6.2) |
| Same wallet and funds | UFVK digest equality and balance parity (7.3, 7.4) |
| Real payment | Purchase B receipt in the seller scanner and the checker (7.6) |
| One crypto family | `cargo tree -d` shows no duplicate zakura/zcash crates (1.2) |
