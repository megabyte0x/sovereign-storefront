# Zakura buyer sender: split into subagent-sized subtasks

Parent plan: `docs/superpowers/plans/2026-09-29-zakura-buyer-sender.md` (read by the orchestrator only; workers get one subtask file plus the shared sections below). This split is plan-only: it authorizes no implementation, commit or push.

Worktree (every path below is relative to it): `/home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet` (branch `feat/public-testnet`).

## How execution works

- The orchestrator is a fresh top-level session (a `delegate_task` child cannot delegate). It dispatches one fresh child per subtask with: this README's `Shared context`, `Global constraints`, `Plan corrections`, `Worker report contract` and `Context hygiene` sections (extract with `awk '/^## Shared context/,/^## Waves/' README.md | sed '$d'`), the full subtask file, the previous subtask's `notes_for_next_subtask`, and a short ORCHESTRATOR NOTES block.
- Same-wave subtasks run in parallel in the same worktree only because their Owns lists are disjoint. Parallel peers must not build the TS project, run `npm install`, run the full vitest suite, or edit outside Owns; cross-file needs go in `deviations`.
- The orchestrator re-runs each subtask's Verify block itself before ledgering (≤3 evidence lines per row).
- Nothing is committed (plan grant). Review packages are built from the working tree: owned tracked diffs plus `git diff --no-index /dev/null <f>` for each owned untracked file. `services/scanner/*` is already dirty from earlier work, so a scanner diff must be restricted to the lines this plan changed.

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

## Worker report contract

Return exactly one JSON object as your final message, and also write it to the report path in ORCHESTRATOR NOTES:

```
{"subtask":"<id>","status":"done"|"blocked","changed_files":[…],
 "commands":[{"cmd":"…","exit":N}],"evidence":["≤5 short lines"],
 "deviations":[{"file":"…","line":N,"text":"…","why":"…"}],
 "notes_for_next_subtask":"≤10 lines: names/signatures you created, anything surprising"}
```

`blocked` needs a one-line reason and the exact failing command. Never paste secrets, receivers or URIs into the report.

## Context hygiene

- Read your subtask file and only the files it names. Do not read the parent plan or other subtask files. Use `search_files`/`grep -n` + `read_file` with offsets instead of whole large files.
- Use only `read_file`, `search_files`, `patch`, `write_file`, `terminal`. No subagents, no browser.
- Timebox: the value in your subtask file. Create your report file within 10 minutes and append after each step, so a stall is visible.
- Cargo output is long: pipe builds to `.runtime/public/diag/buyer-sender-<subtask>.log` and grep `^(error|warning)` from it.

## Waves

| Wave | Subtasks (parallel within a wave) | Owns | Depends on |
|---|---|---|---|
| 0 | P0 orchestrator preflight (no child) | — | — |
| 1 | 1.1 manifest + lockfile | `tools/buyer-sender/Cargo.toml`, `Cargo.lock`, (visibility-only) `services/scanner/src/*.rs` | P0 |
| 2 | 1.2 state + main skeleton + build script | `tools/buyer-sender/src/{main,state}.rs`, `package.json` | 1.1 |
| 3 | 2.1 chain.rs ‖ 5.1 wallet.ts runner ‖ 5.2 live/t01 scripts + docs | `src/chain.rs` ‖ `scripts/public-t01-wallet.ts` ‖ `scripts/public-t01-live.ts`, `scripts/public-t01.ts`, public-testnet README | 1.2 (5.x only need the frozen contract) |
| 4 | 3.1 import/status ‖ 4.1 invoice validation | `src/main.rs`, `src/state.rs` ‖ `src/pay.rs` (new) | 2.1 |
| 5 | 4.2 propose/sign/persist/broadcast → 4.3 tx-status/rebroadcast (serial) | `src/pay.rs`, `src/main.rs` | 3.1, 4.1 |
| 6 | 6.1 Rust tests ‖ 6.2 TS tests | `#[cfg(test)]` modules in `tools/buyer-sender/src/*.rs` ‖ `tests/unit/public-t01{,-wallet}.test.ts` | Waves 3–5 |
| 7 | G gates (orchestrator) → R review (read-only child) → fix rounds | fix owner per finding | 6.x |
| 8 | 7.1 import + key/balance parity → 7.2 purchase B (orchestrator + user) → 7.3 retire zingo + ledger | live state only; README ledger | R clean + live precondition |

Serial note: 3.1 and 4.2/4.3 all edit `main.rs`, so they never share a wave. 4.1 creates `pay.rs` with pure functions only and does not wire `main.rs`.

## Ledger

| Row | Status | Evidence |
|---|---|---|
| split | done 2026-09-29 | Parent plan checked against the worktree; corrections C1–C6 recorded above |
