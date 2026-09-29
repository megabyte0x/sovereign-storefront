# P0 Orchestrator preflight (no child)

Timebox 20 min. Run by the orchestrator itself.

1. `git status --short | wc -l`, HEAD, and `git worktree list` — record in the ledger.
2. Baseline: `npx vitest run > .runtime/public/diag/buyer-sender-P0-vitest.log 2>&1`, `npx tsc --noEmit`, `git diff --check`; `cargo test --locked --manifest-path services/scanner/Cargo.toml > .runtime/public/diag/buyer-sender-P0-scanner.log 2>&1`. Ledger pass/fail counts.
3. Confirm `tools/buyer-sender` does not exist and `~/.local/state/ssf-buyer` does not exist.
4. Confirm the scanner exports listed in README Shared context are still `pub` (`grep -n 'pub ' services/scanner/src/{scan,config,private_fs,cache}.rs`).
5. Snapshot the scanner diff so later reviews can isolate this plan's changes: `git diff services/scanner > .runtime/public/diag/buyer-sender-P0-scanner-baseline.diff`.
6. `mkdir -p .runtime/public/diag` (gitignored; check with `git check-ignore -v`).

Verify: ledger row `P0` with the counts.
