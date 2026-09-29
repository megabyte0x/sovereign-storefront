## Shared context

- The sender is a new Rust crate `tools/buyer-sender` (binary `ssf-buyer-sender`) that replaces zingo-cli as the T01 buyer wallet. It depends by path on the scanner library `services/scanner` and on the same rc5 Zakura wallet crates.
- Frozen binary contract (copy of the parent plan, do not change):

```
ssf-buyer-sender [--state-dir DIR] [--lightwalletd URL] <command>
  import --mnemonic-file F --birthday H
  status
  pay --uri-file F --attempt-id ID [--expiry-delta N]   # N in 10..=40, default 20
  tx-status --attempt-id ID
  rebroadcast --attempt-id ID
```

  - stdout: exactly one JSON object.
    - import `{"ok":true,"birthday":H,"tip":T}`
    - status `{"network":"test","tip":T,"spendableZat":"…","orchardZat":"…","ironwoodZat":"…"}`
    - pay / rebroadcast `{"attemptId":ID,"txid":"<64 hex, display order>","targetHeight":T,"expiryHeight":E,"broadcast":"accepted"|"rejected"|"unknown"}`
    - tx-status `{"attemptId":ID,"txid":…,"state":"mined"|"mempool"|"not_found"|"expired"|"forked","minedHeight":H|null,"tip":T,"expiryHeight":E}`
    - error `{"error":"<fixed &'static str>"}`
  - Exit codes: 0 ok; 2 refused, nothing broadcast, no attempt file; 3 attempt file exists, broadcast outcome unknown; 4 attempt already exists (pay refused before sync).
  - `expired` only when gRPC `NOT_FOUND` **and** `tip > expiryHeight`. Any transport error is an error, never `not_found`.
- Private state: `~/.local/state/ssf-buyer/` (0700): `seed.private`, `wallet.sqlite`, `blocks/`, `attempts/<ID>.json` (0600), `lock` (flock).
- Scanner items already `pub` (checked 2026-09-29): `scan::{within_deadline, SYNC_DEADLINE, GRPC_CONNECT_DEADLINE, GRPC_RPC_DEADLINE}`, `config::{ScannerParams (enum, impl Parameters), ScannerParams::test_network, validate_lightwalletd_endpoint}`, `private_fs::{PrivateDir, private_parent}` with `open_or_create_child`, `ensure_file`, `write_file_atomic`, `proc_path`, and `cache::PersistentBlockCache::{open, open_in}`. `scan.rs::open_wallet` (line 149) and `client` (line 180) are private: copy their pattern, do not export them.
- rc5 API locations in `~/.cargo/registry/src/index.crates.io-*/`: `zakura-client-backend-0.1.0-rc5/src/lib.rs:94` `start_orchard_proving_key_warmup(OrchardCircuitVersion)`; `…/src/data_api/wallet.rs:1033` `propose_standard_transfer_to_address` (12 args: db, params, fee rule, account, confirmations policy, to, amount, memo, change_memo, fallback pool, lock_inputs, proposed_version); `…/src/data_api.rs:415` `ironwood_balance()`; `zakura-client-sqlite-0.1.0-rc5/src/lib.rs:1822/2160` `import_account_hd`.
- TS side: `scripts/public-t01-wallet.ts` (265 lines; `invoiceDigest` at line 76 = `sha256(uri)` hex; `WalletRunner` type at line 24; zingo plumbing at 93–183), `scripts/public-t01-live.ts` (`walletSend`), `scripts/public-t01.ts` (`WALLET_NAME`/`WALLET_VERSION` at lines 9–10). Tests: `tests/unit/public-t01-wallet.test.ts`, `tests/unit/public-t01.test.ts`.

## Global constraints

- Testnet only; no network flag; `ScannerParams::test_network()`; endpoint must pass `validate_lightwalletd_endpoint`; default `https://testnet.zec.rocks:443`.
- Caps: `MAX_SENDS = 2`, `MAX_INVOICE_ZAT = 1_000_000`, `FEE_RESERVE_ZAT = 100_000`; only `utest1` unified receivers, one payment, optional memo.
- Never print, log or put on argv a seed, spending key, UFVK, receiver, ZIP-321 URI or raw transaction. Allowed output: txid, heights, zatoshi amounts, pool names, state words, fixed error strings.
- One wallet process at a time (`flock` on `lock`). zingo-cli is retired for this seed once `import` succeeds.
- Never build a second, different transaction for an invoice that has an unresolved attempt; only rebroadcast identical bytes.
- Do not touch the running T01 runner, `buyer-sends.json`, `t01-run.json` or `.runtime/public/buyer-wallet/` before Wave 8's precondition holds.
- No commits, no push, no paid resources. No `cargo update` / `cargo generate-lockfile`. Scripts must load under `node --experimental-strip-types` (no enums, no constructor parameter properties).
- User direction: dev subtasks (Waves 1–5) write **no tests**; all tests are Wave 6. Dev subtasks must still create the seams Wave 6 needs (see Plan corrections C1).

## Plan corrections (orchestrator rulings from the 2026-09-29 check; fold into every brief)

- **C1 Test seams in dev tasks.** Parent 6.1 tests a panicking client factory and status/broadcast decode without a network, but Tasks 2 and 4 never create those seams. Dev subtasks must expose: pure `decode_status(result: Result<RawTransaction, tonic::Status>, requested_txid, tip, expiry) -> Result<TxState, &'static str>`, pure `map_broadcast(Result<SendResponse, _>) -> Broadcast`, pure `validate_invoice(bytes, attempt_id) -> Result<Invoice, &'static str>`, pure `parse_expiry_delta`, and command handlers generic over a `ChainFactory` (trait or closure) so `pay`'s guard can be tested with a factory that panics.
- **C2 Attempt-id digest.** TS computes `sha256(uri)` with no trim (line 76); the parent plan's binary hashes "file bytes, trimmed". Rule: TS writes the exact digested string with no trailing newline; the binary hashes the exact file bytes, no trim. Any mismatch is exit 2.
- **C3 Status decode branch id.** For `Transaction::read`, use `BranchId::for_height(&params, h)` with `h = raw.height` when mined, else `tip + 1` (v5+ transactions carry their own branch id; this only has to be a consistent, valid choice).
- **C4 Exit-2 wording.** Errors after `create_proposed_transactions` but before the attempt file is written (e.g. `get_transaction`, expiry mismatch) still exit 2: nothing was broadcast, but a signed tx exists in `wallet.sqlite` and its notes are locked until expiry. That is safe; the TS "nothing was signed" comments should say "nothing was broadcast".
- **C5 Parent 1.3 is expected to be a no-op** (all listed items are already `pub`). If a worker finds otherwise, it changes only the visibility keyword.
- **C6 Added final review.** The parent plan has no review step. Wave 7 adds one read-only review of the complete working-tree package before any live action.


# REVIEW TASK (read-only)

You are the final code reviewer for the Zakura buyer sender. cd /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet. Read-only: no edits, no builds, no network, no subagents, no commits.

Package: /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet/.runtime/public/diag/buyer-sender-review.diff (read it in chunks with read_file offset/limit). You may also read the source files directly.

Package notes:
- tools/buyer-sender/* is wholly new (this plan).
- scripts/public-t01-wallet.ts, scripts/public-t01-live.ts, scripts/public-t01.ts, tests/unit/public-t01{-wallet,}.test.ts and docs/superpowers/plans/2026-09-26-public-testnet-hosting/README.md are untracked files from earlier work, so the package shows them whole. This plan changed: public-t01-wallet.ts (full rewrite onto the sender), public-t01-live.ts (walletSend resolve poll, exported WalletSendOptions), public-t01.ts (WALLET_NAME/WALLET_VERSION only), the two test files, and the README (ledger row 5.2g + one CUA-scope sentence). Focus on those parts.
- Gates already run by the orchestrator (do not re-run): vitest 736/736, tsc, clippy -D warnings, cargo test 29/29, scanner 108/108, no duplicate crypto crates.

Review against: the frozen contract (every output shape and exit code), persist-before-broadcast (no exit 2 after the attempt file is written), exit-4 guard before any network, `expired` only on NOT_FOUND + tip > expiry and transport errors never not_found, no seed/key/UFVK/receiver/URI/raw tx in stdout, argv, logs or Debug impls, flock held for the whole command, 0600/0700 modes, the TS resolve table (mined->sent, expired->expired, not_found/forked->rebroadcast+pending, mempool/exit3->pending, no-txid + 'no attempt recorded' -> removed), never a second transaction per invoice, TS/Rust exit-code consistency (note: tx-status connect/tip failures currently exit 2 — judge whether the TS side handles that safely).

Known orchestrator-accepted departures (judge them, don't assume they're right): global flags accepted after the command; state dir fallback mkdir 0700 when the parent is 0755; CommandResult carries the exit code in Ok; prover warm-up via bundle_version_for_branch; spawn failure (127) treated as nothing broadcast; walletSend stops polling early on 'expired' and returns ambiguous.

Output: findings tagged [Critical]/[Important]/[Minor] with file:line and a one-line fix each, then a verdict (clean / needs fixes). Write the same text to /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet/.superpowers/sdd/2026-09-29-zakura-buyer-sender/reports/R.md and return it.
