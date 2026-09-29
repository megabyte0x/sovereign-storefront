# Scoped re-review — fix round 1 (read-only)

cd /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet. Read-only: no edits except your report, no builds, no network, no subagents.

Inputs: findings in /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet/.superpowers/sdd/2026-09-29-zakura-buyer-sender/reports/R.md; fixer report /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet/.superpowers/sdd/2026-09-29-zakura-buyer-sender/reports/fix1.json; fix diff /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet/.runtime/public/diag/buyer-sender-fix1-review.diff (pre-fix vs current for the 5 changed files). You may read current source files.

Findings to verdict (ADDRESSED / NOT ADDRESSED, with file:line): I-1 attempts dir (and root when newly created) fsynced after attempt write; I-2 send refuses any existing ledger record for the digest; I-3 unreadable/unparseable existing attempt file -> exit 3 in pay/tx-status/rebroadcast, factory not called; I-4 Attempt Debug redacts raw_hex; M1 tx-status/rebroadcast connect/tip failures after an attempt is read -> exit 3; M2 TS adopts txid/state only when attemptId == digest; M3 exit-4 fixtures print the attempt shape.

Also flag NEW Critical/Important breakage in the fix diff only, especially: any path that now exits 2 after an attempt file was written (persist-before-broadcast invariant), any secret/raw tx now reaching output, and the fsync-failure path (it deletes a just-written attempt file before broadcast — confirm nothing was broadcast yet). Out-of-scope observations -> list as deferred Minor.

Gates already run by orchestrator: cargo test 34/34, clippy, fmt, vitest 742/742, tsc.

Write the result to /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet/.superpowers/sdd/2026-09-29-zakura-buyer-sender/reports/RR1.md and return it: per-finding verdicts, new findings, overall verdict.
