# Fix round 1 — Zakura buyer sender (review findings)

cd /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet. Report path: /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet/.superpowers/sdd/2026-09-29-zakura-buyer-sender/reports/fix1.json (create within 10 min, update per step). Read /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet/.superpowers/sdd/2026-09-29-zakura-buyer-sender/reports/R.md for full finding text. Read only the files named below (use offsets).

Forbidden: git commit/push/stash/checkout, cargo update/generate-lockfile, npm install, network, touching .runtime/public/{buyer-sends.json,t01-run.json,buyer-wallet} or any T01 process, subagents, editing files other than those listed. Never print secrets/URIs.

Owns: tools/buyer-sender/src/{state,pay,chain,main}.rs, scripts/public-t01-wallet.ts, tests/unit/public-t01-wallet.test.ts.

Fix, each with a covering test (Rust #[cfg(test)] or vitest):
- I-1 state.rs ~227-260: after write_attempt creates the attempt file, fsync the `attempts/` directory fd; when `attempts/` is newly created, fsync the state root dir fd too. (PrivateDir wraps an fd; use nix::unistd::fsync or File::sync_all on the dir handle.) Test: write_attempt still works and file mode 0600 (fsync itself not observable — say so).
- I-2 scripts/public-t01-wallet.ts ~348 + test ~222-238: `send` refuses (exit 2, message telling the caller to request a new invoice) when the ledger already has any record (sent OR expired OR pending) for that digest. Update the test that currently expects re-send after expired to expect refusal, and assert no `pay` call.
- I-3 pay.rs ~180-184: if an attempt file exists but cannot be read/parsed, pay_guard (and tx-status/rebroadcast recorded_attempt) must exit 3 with a fixed error (e.g. "attempt file is unreadable"), never 2. A missing file stays Ok(None). Distinguish in state.rs read_attempt if needed (e.g. separate error variants or a two-level result). Invalid attempt-id format stays exit 2. Test: corrupt attempt file -> exit 3, factory never called.
- I-4 state.rs:45: replace derived Debug on Attempt with a manual impl that prints raw_hex as "<redacted>" (txid, heights, amount may print). Test: format!("{:?}") lacks the raw hex.
- M1 pay.rs ~339-340: in tx-status, once the attempt was read, connect/tip failures exit 3 (print {"error":…}), not 2. Same for rebroadcast connect/tip failures. "no attempt recorded" stays 2. TS side already treats non-'no attempt recorded' failures as pending — confirm in a test.
- M2 public-t01-wallet.ts ~225: before adopting a txid from tx-status/pay/rebroadcast JSON, require json.attemptId === record.invoiceDigest; else leave pending. Test it.
- M3 test ~263-286: exit-4 fixtures must print the attempt shape (attemptId, txid, targetHeight, expiryHeight, broadcast:'unknown') with code 4, like the real binary.

Verify and report each exit code:
- cargo test --locked --manifest-path tools/buyer-sender/Cargo.toml (log .runtime/public/diag/buyer-sender-fix1-test.log)
- cargo clippy --locked --manifest-path tools/buyer-sender/Cargo.toml --all-targets -- -D warnings
- rustfmt --edition 2024 --check tools/buyer-sender/src/*.rs
- npx vitest run tests/unit/public-t01-wallet.test.ts tests/unit/public-t01.test.ts
- npx tsc --noEmit
(Hermes patch-tool lint runs rustc as edition 2015 and shows false async errors; cargo is authoritative.)

Return JSON: {"subtask":"fix1","status":"done"|"blocked","changed_files":[…],"commands":[{"cmd","exit"}],"evidence":[…],"findings":{"I-1":"file:line","I-2":…,…},"deviations":[…]}
