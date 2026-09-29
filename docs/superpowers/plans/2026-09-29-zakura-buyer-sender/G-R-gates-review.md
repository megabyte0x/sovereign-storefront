# Wave 7: gates (orchestrator) and final review (read-only child)

## G gates — orchestrator, no child  (parent Task 6.4)

Short separate terminal calls, each ≤600 s, logs under `.runtime/public/diag/buyer-sender-G-*.log`:
1. `npx vitest run` (full; re-measure the count vs P0, don't use an old number; re-run `build-provenance`/`log-secrecy` alone if they flake).
2. `npx tsc --noEmit`; `git diff --check`.
3. `cargo clippy --locked --manifest-path tools/buyer-sender/Cargo.toml -- -D warnings`; `cargo test --locked --manifest-path tools/buyer-sender/Cargo.toml`.
4. `cargo test --locked --manifest-path services/scanner/Cargo.toml`; `git diff services/scanner` vs the P0 snapshot shows no change (or only 1.1's visibility edits).
5. `cargo tree … -d -e normal | grep -E '^(zakura|zcash|orchard|sapling|halo2)'` empty.
6. Acceptance greps: `grep -inE 'zingo|nym|SSF_BUYER_TRANSPORT' scripts/public-t01-wallet.ts` empty.
7. Smoke-load all three scripts under `node --experimental-strip-types`.

## R review — one read-only child

Package: owned tracked diffs (`package.json`, the three scripts, two test files, public-testnet README, scanner lines beyond the P0 snapshot) + `git diff --no-index /dev/null` per file under `tools/buyer-sender/` (excluding `target/`, and `Cargo.lock` as a stat only). Write to `.runtime/public/diag/buyer-sender-review.diff`; check it is nonempty.

Reviewer brief: README Shared context, Global constraints, Plan corrections + the package path. Review against: frozen contract (every shape and exit code), persist-before-broadcast (no exit 2 after the attempt write), exit-4 guard before any network, `expired` only on NOT_FOUND + tip>expiry, no secret/URI/receiver/raw tx in output, argv, logs or Debug, flock held for the whole command, 0600/0700 modes, TS resolve table, no second transaction per invoice. Output: `[Critical]/[Important]/[Minor]` findings with file:line; verdict.

Fix rounds: each Critical/Important goes to one child owning just the affected file(s); re-run G, then a scoped re-review of the fix diff. Minors are ledgered and carried to 7.3.
