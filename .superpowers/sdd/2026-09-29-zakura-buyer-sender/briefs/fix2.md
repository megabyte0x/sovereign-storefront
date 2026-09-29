# Fix round 2 — I-1 remainder (buyer sender)

cd /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet. Report: /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet/.superpowers/sdd/2026-09-29-zakura-buyer-sender/reports/fix2.json. Read /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/public-testnet/.superpowers/sdd/2026-09-29-zakura-buyer-sender/reports/RR1.md (the I-1 section) first, then tools/buyer-sender/src/state.rs around lines 270-350.

Problem: the state-root fsync in write_attempt runs only when write_attempt itself creates attempts/. In a real pay, pay_guard -> read_attempt -> attempts() (open_or_create_child) creates attempts/ first, so the root is never fsynced.

Fix: make the directory creation durable wherever it happens — in the shared helper that opens/creates attempts/, detect creation (e.g. check existence before open_or_create_child) and fsync the state root right after creating it; remove the now-dead attempts_created branch in write_attempt (keep the attempts/ dir fsync after the file write). Reuse the existing sync_dir_of helper. An fsync failure while creating attempts/ in the read path must follow the existing unreadable/exit-3 rule if it happens inside read_attempt, and the existing refuse path inside write_attempt.

Test (D4): a unit test that on a fresh state root runs the real order — read_attempt (Ok(None), creates attempts/) then write_attempt — and asserts both succeed and attempts/ exists 0700 and the file 0600. Fsync itself is not observable; say so.

Owns: tools/buyer-sender/src/state.rs only (plus its #[cfg(test)] module). Forbidden: commits, network, subagents, other files.
Verify (report exits): cargo test --locked --manifest-path tools/buyer-sender/Cargo.toml; cargo clippy --locked --manifest-path tools/buyer-sender/Cargo.toml --all-targets -- -D warnings; rustfmt --edition 2024 --check tools/buyer-sender/src/*.rs.
Return JSON {"subtask":"fix2","status","changed_files","commands","evidence","deviations"}.
