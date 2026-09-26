# Finish the live MVP: fast plan for everything still open

This plan replaces the open tail of `2026-09-26-remaining-tasks-split.md` (R4.5 after the harness core, then R4.6, R4.7, R4.8 and R5). Task 11, Task 8, and Tasks 9 and 7 are closed, and their evidence is in that file's ledger. The requirements still come from the parent plan `2026-09-23-live-mvp-integration.md`. This file only decides what is left, who does it, and how it is checked.

Goal: close Task 12 and the parent plan with an honest L01–L16 report, from the fewest serial steps.

    F0  Preflight                                   orchestrator, 10 min
    F1  Code wave (5 parallel workers)              ~60-90 min wall clock
    F2  Evidence run (automated suites + your manual L session)   ~60-90 min
    F3  Report and docs from the observed run       1 worker, 45 min
    F4  Final review, then fix loop                 1 reviewer (+1 fixer)
    F5  Close-out and hand-off for commit           orchestrator, 20 min

Why it is fast:
- F1 contains every remaining code change, split into five disjoint file sets that run at once.
- The only serial human step is your manual L session in F2.
- There is one final review, over F1–F3 together, instead of a review per task.

## What is already done (don't redo)

| Area | State | Evidence |
| --- | --- | --- |
| Tasks 0–4, 6, 10 | complete | parent-plan status blocks; R0.4 ledger rows |
| Task 11 backup/restore | closed | R1 ledger: live 7/7, re-review clean |
| Task 8 replica reads | closed | R2 ledger: strict storage 5/5, origin-stop 1/1 |
| Tasks 9 and 7 browser over Waku | closed | R3 ledger: test:browser 30/30, review clean |
| Task 12 first wave | done | `scripts/live-report.ts`, `live-resources.ts`, `live-pay.ts`, expiresAt fix, Import backup control, demo-check harness core |
| R4 review fix1 | done, **not re-reviewed** | R4 fix1 ledger rows; npm test 537/537 |
| Live stack | up | strict doctor 6/6; seller on :8787/:8788 (manual-seller.log) |

## Open items and owners

| # | Open item | Source | Owner |
| --- | --- | --- | --- |
| 1 | 7 R3 Minors (browser M1–M7) | task-R3-review.md | F1.1 |
| 2 | 4 R2 Minors (origin-stop finally, tamper error class, logos-node status, L12 scope note) | task-R2-review.md | F1.2 (the scope note goes to F3) |
| 3 | Task 5 crash-boundary tests, and restricting test-only mutation APIs (2 unticked boxes) | parent plan Task 5 | F1.3 |
| 4 | Task 4 ZIP-321 box "not independently re-verified" | parent plan Task 4 | F1.4 |
| 5 | Turning manual observations into a validated `report.json` | Task 12 box 4–6, D4 | F1.5 |
| 6 | Re-review of R4 fix1 | R4 ledger | F4 (folded into the final review) |
| 7 | The L run itself | Task 12 boxes 3–6 | F2 (you + orchestrator) |
| 8 | Results docs, runbook, design status lines | Task 12 box 8 | F3 |
| 9 | 32 unticked parent-plan boxes, and plan and ledger agreement | R5 | F5 |

Out of scope, by your decisions:
- The live Playwright spec, `playwright.live.config.ts`, and the `demo:live` and `test:live` scripts. You test manually. `runDemoLive` stays a tested library function.
- T01 on testnet (D4 = no; it is written as NOT_RUN with a reason).
- New dependencies (D3 = no).

## Shared context (copy into every brief)

- Work in `/home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/live-mvp-integration`, branch `feat/live-mvp-integration`. Nothing is committed. Do not commit, push, `npm install`, or change `package.json` or lockfiles.
- The baseline is `npm test` 537/537 (65 files), with tsc 0 and `git diff --check` 0. `tests/unit/log-secrecy.test.ts` and `tests/unit/build-provenance.test.ts` can fail under CPU load. Re-run the file alone before calling a failure a regression.
- The live stack is shared state. Workers in F1 must not run `infra:*`, must not stop or start any Logos node, scanner, or seller, and must not run any live-gated suite (`SSF_LIVE_*`, `SSF_STRICT_LIVE*`).
- TDD: write the RED test first, within about 15 minutes of starting. Then make it GREEN and run the focused files plus `npx tsc --noEmit`. Don't run the full suite (the orchestrator does that).
- Create your report file early at `.superpowers/sdd/2026-09-23-live-mvp-integration/task-F<n>-report.md` and append to it after each step.
- Report contract (at most 25 lines): status `done|blocked`, files changed, RED→GREEN evidence (test name + count), commands run with exit codes, `deviations` (one-line edits needed in files you don't own), and `notes_for_next_subtask`.
- Logs and evidence never contain secrets, plaintext product bytes, full addresses, UFVKs, tokens, or full ZIP-321 URIs.

## F0 Preflight (orchestrator, no subagents)

1. `git status --short | wc -l` and HEAD. Then `npx vitest run > .runtime/live/diag/F0-vitest.log 2>&1` and expect 537 pass. Also `npx tsc --noEmit` and `git diff --check`.
2. `SSF_STRICT_LIVE=1 npm run infra:doctor 2>&1 | tee .runtime/live/diag/F0-doctor.log`, with the exit taken from `${PIPESTATUS[0]}`. Expect 6/6 PASS.
3. Record the count of `$TMPDIR/ssf-logos-*` dirs as the leak baseline for F2.
4. Ask **G1** in one clarify call:
   - Keep the manual seller running during F1 (recommended; F1 touches no runtime code the running seller loads until a rebuild), or stop it now.
5. Write the F0 ledger rows.

## F1 Code wave (one parallel batch, disjoint files)

Dispatch F1.1–F1.5 as one `delegate_task` batch. Each worker gets a 90-minute cap.

### F1.1 Browser Minors from the R3 review

- **Owns:** `src/browser/app.ts`, `src/browser/waku-transport.ts`, `src/browser/purchases.ts`, `tests/unit/browser-transport-select.test.ts`, `tests/unit/waku-transport.test.ts`, `tests/unit/purchases-migration.test.ts`, and a new `tests/unit/browser-r3-minors.test.ts`.
- **Steps (each one RED first):**
  1. M1: fixture mode needs the 404 **and** the fixture seller's product marker, not the 404 alone. Anything else selects `unavailable`.
  2. M7: a malformed 200 `/api/waku-config` body (bad seller key, unknown network, missing fields) selects `unavailable`. Add the unit case.
  3. M2: recover with a `derivePackageId` mismatch is rejected, and nothing is saved.
  4. M3: ack is sent only after a verified decrypt. A failed decrypt sends no ack. Add a unit test with a fake transport that counts acks.
  5. M4: `saveDelivery` on recover refuses to overwrite an existing delivery with a different `packageId`, the same rule the push path uses. The same `packageId` is a no-op.
  6. M5: an imported v2 backup's delivery is re-verified with `decodeStored` before it is stored. A tampered delivery rejects the whole import, with the generic notice.
  7. M6: one unknown-version row is skipped and counted, not thrown. `list()` returns the other rows plus a `skipped` count, and the UI shows a generic "some purchases could not be read" notice.
- **Verify:** `npx vitest run tests/unit/browser-*.test.ts tests/unit/waku-transport.test.ts tests/unit/purchases*.test.ts tests/unit/checkout.test.ts`, then tsc.

### F1.2 Storage and live-test Minors from the R2 review

- **Owns:** `tests/integration/storage-origin-stop.test.ts`, `tests/integration/storage.test.ts`, `scripts/live-infra/logos-node.ts`, `tests/unit/live-infra-logos-node.test.ts`.
- **Steps:**
  1. In origin-stop, `finally` keeps the body error and rethrows it. If cleanup also fails, throw an `AggregateError([bodyErr, cleanupErr])`. Unit-test the helper by extracting it as an exported `runWithRestore(body, restore)` inside the test file's sibling helper, or inline it with a small unit in `logos-node.test.ts`.
  2. The tamper decrypt asserts the exact integrity/AEAD error class or message. Read it from the decrypt code; don't guess.
  3. `logos-node stop`: only `stopped` and `not_configured` are no-ops. Any other status runs the ownership-checked stop path, or refuses with a clear message. RED unit case: `degraded` with a live pid.
- **Verify:** `npx vitest run tests/unit/live-infra-logos-node.test.ts`, then tsc. Don't run the live suites; the orchestrator runs them in F2.

### F1.3 Task 5 crash-boundary tests

- **Owns:** `tests/unit/fulfillment-crash.test.ts` (new). The worker reads `src/seller/fulfillment.ts`, `src/seller/store*.ts`, and `src/seller/payments.ts`. If a production change is needed, report it as a deviation, except one case: the worker may restrict a test-only mutation API in a file it names in the report, provided no other F1 worker owns that file (none do).
- **Steps:**
  1. Use per-`openStore` crash injection (no process-global hooks) at each boundary: before snapshot commit, after commit/before package prepare, after prepare/before send intent, after intent/before send, after send/before outcome, and after acceptance/before ack. At each one, reopen and assert: no double disclosure, the same `packageId`, and progress continues.
  2. A wrong-buyer recover/ack always fails. Duplicate ack is idempotent. The existing reorg tests in `fulfillment.test.ts:269,287` count as covering the reorg cases; reference them rather than duplicating.
  3. `grep` the production assembly (`src/main.ts`, `src/runtime.ts`, `src/seller/server.ts`) for per-observation mutation APIs used only in tests. List them. Restrict each one so it is not reachable from the production wiring, or report "none found" with the grep.
- **Verify:** `npx vitest run tests/unit/fulfillment*.test.ts tests/unit/payments.test.ts tests/unit/invoices.test.ts`, then tsc.

### F1.4 ZIP-321 independent round trip

- **Owns:** `services/scanner/src/wallet.rs` (the `#[cfg(test)]` module only), and a new `tests/unit/zip321-roundtrip.test.ts`.
- **Steps:**
  1. Add a Rust test: `zip321_payment_uri(dest, amount)` is parsed back with the `zip321` crate. The amount and address must be exact, and the canonical zatoshi → ZEC string must hold at 1, 100000 and 2_100_000_000_000_000 zat.
  2. Add a TS test: `validatePaymentUri` (`src/adapters/wallet-scanner.ts`) accepts that exact vector and rejects an amount mismatch, an address mismatch, and an extra param. An image-QR decode test already exists in `tests/unit/payment-request.test.ts` (jsqr). Reference it in the report rather than adding another.
- **Verify:** `cargo test --locked --manifest-path services/scanner/Cargo.toml zip321` plus the focused vitest file. Don't run `cargo build --release`: the live binary must not change during F1.

### F1.5 Manual-run recorder

- **Owns:** `scripts/live-observe.ts` (new), `tests/unit/live-observe.test.ts` (new), and `docs/live-test-checklist.md` (new).
- **Purpose:** turn what you observe in the manual session into a `report.json` that `validateLiveReport` accepts or honestly rejects. It fills L rows only from recorded observations, and T01 is NOT_RUN (D4).
- **Steps:**
  1. The CLI is `node --experimental-strip-types scripts/live-observe.ts`:
     - `init`: creates a 0600 `.runtime/live/demo/observations.json`, captures build provenance through `readBuildProvenance`, and reads the adapter identities from the running seller's `ready` line and log.
     - `stage <id> --status PASS|FAIL|NOT_RUN --evidence "<text>"...`: appends one stage row. Evidence goes through `sanitizeEvidence`, and a refused value makes the row FAIL without writing the value.
     - `suite <L-id> --ok|--fail --evidence ...`: per-row named suite evidence.
     - `finalize`: `assembleLiveReport` → `validateLiveReport` → writes a 0600 `report.json`. It prints the per-row PASS/FAIL/NOT_RUN table and exits nonzero unless the report is ok.
     - It accepts only ids from `L_MATRIX_IDS` and `WORKFLOW_STAGE_IDS`.
  2. RED tests: an unknown stage id is refused; a secret-shaped evidence value gives FAIL and the value is absent from the file; the file mode is 0600; `finalize` on a partial file lists the missing stages and exits nonzero; recording the same stage twice keeps the last row and notes the overwrite.
  3. `docs/live-test-checklist.md`: one section per workflow stage, in the parent plan's L order. Each section gives the exact command or DOM control, what to observe, and the exact `live-observe stage` line to record it. It uses only commands that exist: `publish-live.ts`, `live-pay.ts fund|mine|confirmations`, `logos-node.ts stop|start|status --node a`, `start:live`, `infra:up`, `infra:doctor`, and `backup:live`. State the seller-stop rule (wrapper PID only) and the node-A restart/re-prove rule.
- **Verify:** focused vitest plus tsc. Also check that every command in the checklist exists (`grep -o 'scripts/[a-z/-]*\.ts' docs/live-test-checklist.md | sort -u` against `ls`).

### F1 gate (orchestrator)

1. Apply the reported deviations. Run `npm test` to a diag log (baseline 537 plus the new tests), `npx tsc --noEmit`, `npm run build`, `npm run test:browser` (F1.1 touched `app.ts`), and `git diff --check`.
2. Rust: `cargo fmt --check`, `cargo clippy --locked -- -D warnings`, and `cargo test --locked`.
3. Ledger rows, one per worker plus the gate.

## F2 Evidence run (serial)

### F2.1 Automated evidence (orchestrator, about 30 min)

1. Doctor 6/6 and the leak count.
2. `npm run build:clean`. Restart the manual seller through its wrapper if F1 changed runtime code (G1). If you're away, ask first before stopping it.
3. Run each gated live suite on its own, writing to `.runtime/live/diag/F2-<suite>.log`:
   - `SSF_STRICT_LIVE=1 npx vitest run -c vitest.integration.config.ts tests/integration/storage.test.ts`
   - `SSF_LIVE_ORIGIN_STOP=1 SSF_STRICT_LIVE=1 ... storage-origin-stop.test.ts` (this stops node A; D2(a) covers it)
   - `SSF_LIVE_BACKUP=1 ... live-backup.test.ts`
   - `SSF_LIVE_RUNTIME=1 ... live-runtime.test.ts`
   - `SSF_STRICT_LIVE_WAKU=1 ... waku.test.ts`
   - `SSF_STRICT_LIVE=1 npx playwright test tests/browser/waku-flow.spec.ts`
   Each suite runs under 600 s. Afterwards, doctor 6/6 again (re-prove A with `infra:up` if the origin-stop cleanup left replication stale).
4. Record each result through `live-observe suite <L-id> ...` against the matrix rows it evidences. Skips are recorded as skips and never counted as passes.

### F2.2 Your manual L session (you, about 45 min)

1. Follow `docs/live-test-checklist.md` from top to bottom. After each stage, run its `live-observe stage` line, or tell the orchestrator what you saw and it records it.
2. A FAIL is a valid result. Record it and keep going. Don't re-run the whole session more than twice.

### F2.3 Finalize (orchestrator)

`live-observe finalize`, then read `report.json` back through `validateLiveReport`. Ledger the per-row PASS/FAIL/NOT_RUN counts. Doctor 6/6 again, the leak count unchanged, and no stray `logosctl watch` or seller processes except the manual seller.

## F3 Report and docs from the observed run (1 worker, 45 min)

- **Owns:** `docs/demo-results.md`, `docs/integration-report.md`, `docs/runbook.md`, and the status lines only in `docs/mvp-design.md` and `docs/design-decisions.md`.
- **Steps:**
  1. Append a dated "Live L run" section to `demo-results.md`, generated from `report.json`. Every L row gets its status and an evidence pointer; FAIL and NOT_RUN rows are stated plainly; T01 is NOT RUN (D4). Add the R2 scope note: L12 covers origin stop plus B fetch, plus whatever F2.2 observed for the gateway restart and fresh-context decrypt.
  2. The runbook gets the exact commands that succeeded in F2. Historical sections are kept (append, don't rewrite).
  3. No "production", "testnet ready" or mainnet claim.
- **Verify (orchestrator):** a secret-shape grep; every command in the docs exists; the numbers match `report.json`; `git diff --check`.

## F4 Final review (1 reviewer, read-only)

- **Package:** `.superpowers/sdd/2026-09-23-live-mvp-integration/task-F-review-package.diff`, built from the working tree. It contains the stat, `git diff -U10` over the R4 and F1 owned tracked paths, a `--no-index` diff per owned untracked file, `report.json` (sanitized), and the F3 docs diff. Confirm it is not empty.
- **Scope:** the R4 fix1 re-review (camelCase adapter denylist, sanitizer inside assembly, per-row suite evidence, doctor row ids, realpath cleanup, txid JSON-only, expiresAt < 1e14), the F1 changes, and the claims in `report.json` and the docs matched against evidence. Check that no fixture appears in a PASS row, that no skip is counted as a pass, and that only owned resources were touched.
- A Critical or Important finding means one fresh fixer, then a scoped re-review. Stop and ask after 3 rounds.

## F5 Close-out (orchestrator)

1. Parent plan: tick every box that has evidence (Tasks 0–5 from R0.4 plus F1.3/F1.4, and Task 12 from F2/F3). Annotate the rest as open with a reason: Task 12 automated `demo:live` is "not produced, manual run by user decision"; T01 is NOT RUN (D4). Update Section 5 with a one-paragraph status.
2. One read-only reviewer checks that the parent plan, the R-plan ledger, this ledger, `progress.md` and `demo-results.md` agree.
3. Final gate: `npm test`, `npm run typecheck`, `npm run build:clean`, `npm run test:browser`, Rust fmt/clippy/test, `git diff --check`, doctor 6/6.
4. Hand off for a manual commit with two lists:
   - Files that belong in the commit: the tracked diffs, the new scripts and tests, and `docs/superpowers/**`.
   - Files that must not be committed: `.runtime/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `test-results/`.
   Suggest Conventional Commit splits (feat/test/docs), but don't commit.

## Launch prompt (paste into a fresh top-level session)

    Execute docs/superpowers/plans/2026-09-26-finish-live-mvp.md as orchestrator in
    /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/live-mvp-integration.
    Read its Ledger first. Run F0, dispatch F1.1-F1.5 as one parallel batch, verify
    each result yourself, run the F1 gate, then F2 (pause for my manual session),
    F3, F4, F5. Stop and ask me at G1, on any blocked result, or after 3 failed
    review rounds. Do not commit or push.

## Ledger (orchestrator appends one line per event)

| Step | Status | Evidence (≤ 3 lines) |
| --- | --- | --- |
| plan | written | 2026-09-26: replaces R4.5-tail/R4.6-R4.8/R5 of remaining-tasks-split; baseline npm test 537/537, doctor 6/6, manual seller up on :8787/:8788 |
| F0.1 | done | HEAD bd5e53c, 92 status lines; `npx vitest run` 538/538 (65 files; baseline is 538, not 537); tsc 0; `git diff --check` 0 |
| F0.2 | done | strict doctor 6/6 PASS (F0-doctor.log), exit 0 |
| F0.3 | done | leak baseline: 807 `$TMPDIR/ssf-logos-*` dirs |
| G1 | answered: stop | user chose to stop the manual seller; SIGTERM to the start-live wrapper pid 2853890 (cmdline checked); :8787/:8788 free, no main.js process left |
| F1 | dispatched | deleg_1b09c86b: F1.1 sa-0-158e7c79, F1.2 sa-1-f858d07f, F1.3 sa-2-e77a8abe, F1.4 sa-3-ba02c226, F1.5 sa-4-8b3d32aa; briefs in .superpowers/sdd/.../briefs/F1.{1..5}.md; 90-min cap |
| F1.1 | done | browser R3 Minors M1-M7; new tests/unit/browser-r3-minors.test.ts 13/13; focused vitest 38/38; tsc 0; deviations none |
| F1.2 | done | logos-node stop treats only stopped/not_configured as no-op; runWithRestore (AggregateError); tamper asserts DecryptionFailed 'manifest mismatch'; unit 20/20; live suites left for F2 |
| F1.3 | done | tests/unit/fulfillment-crash.test.ts 12/12 (6 crash boundaries + wrong-buyer/dup ack); no production edits; per-observation mutation APIs not reachable from production wiring (none found) |
| F1.4 | done | wallet.rs #[cfg(test)] zip321 round trip (existing zip321 =0.9.0 dep, no new deps); zip321-roundtrip.test.ts 4/4; cargo test zip321 pass |
| F1.5 | done | scripts/live-observe.ts + tests/unit/live-observe.test.ts 5/5 + docs/live-test-checklist.md; all 6 referenced scripts exist on disk |
| F1 gate | done | npm test 580/580 (69 files); tsc 0; git diff --check 0; npm run build 0; test:browser 30/30; cargo fmt/clippy -D warnings/test --locked all 0 (55+ lib tests) |
| F2.1 storage | PASS | SSF_STRICT_LIVE=1 storage.test.ts 5/5 (F2-storage.log). NOTE: suite reads LOGOSCTL/LOGOS_NODE_A/LOGOS_NODE_B from the process env, so live.env must be sourced first; the plan's bare command line fails all 4 live cases |
| F2.1 origin-stop | FAIL (honest) | storage-origin-stop 1/1 failed: 'node-a daemon still running after daemon stop' (F2-origin-stop.log). Reproduced by hand: logos-node stop exits 1 with the same message, but the daemon IS stopped (status 'not_running', state.json gone) — the poll reads the raw logosctl exit code and treats a nonzero exit on a valid stopped-status JSON as failure. Stack restored with infra:up, doctor 6/6 |
| F2.1 backup | PASS | SSF_LIVE_BACKUP=1 live-backup.test.ts 7/7 |
| F2.1 runtime | PASS | SSF_LIVE_RUNTIME=1 live-runtime.test.ts 7/7 |
| F2.1 waku | PASS | SSF_STRICT_LIVE_WAKU=1 waku.test.ts 1/1 |
| F2.1 waku-flow | PASS | SSF_STRICT_LIVE=1 playwright waku-flow.spec.ts 1/1 (31 s) |
| F2.1 close | done | doctor 6/6 after (F2-doctor-after.log); leak count 806 vs F0 baseline 807 (drop, not a leak; Hermes scratch prune) |
| F2.2 run1 | abandoned | leftover 'Demo product' row served instead of the new publish (user approved unpublishing it); first-press invoice missing and interrupt missed; user chose a clean retry. Seller DB + observations archived to .runtime/live/archive/run1-133314/ (seller only; chain/scanner/Logos unchanged) |
| F2.2 run2 | in progress | fresh seller DB, v-run2 published; 12 stages PASS so far (publish, replica-b, two-invoices, fund-a, below-threshold at 9 conf, threshold, interrupt, restart, waku-recover, ack, origin-stop, gateway-restart); downloaded bytes cmp-equal to published 14 B; seller state sent_unacknowledged -> acknowledged |
| F2.2 import bug | fixed (orchestrator, user-approved) | live backup import refused: sanitizeInvoice required network 'test' + legacy attributionRef, so every regtest receiver-attributed backup failed. RED tests/unit/purchases-live-invoice-import.test.ts (1 fail) -> GREEN 5/5 via sanitizeLiveInvoice reusing validateChainIdentity/validateReceiver; real invoice-A backup imports in a scratch probe; npm test 584/585 (build-provenance timeout, 2/2 alone); tsc 0; diff --check 0; build:clean 0; seller restarted, assets 200 |
| F2.2 run2 | done | 17/17 stages PASS: clean purchase 79de2260 delivered + acknowledged without restart, reload reconnect with no second invoice (3 orders, 1 invoice each), invoice B locked 0 packages throughout; three browser downloads cmp-equal to published 14 B. Named suite rows L02-L08, L10, L13-L16 recorded from F1 gate / F2.1 / run2 evidence (L06-L08 deterministic tests, labelled) |
| F2.3 | partial | finalize exit 0; validateLiveReport ok, errors []; 33 PASS / 0 FAIL / 1 NOT_RUN (T01, D4); report.json 0600; strict doctor 6/6; ssf-logos-* 793 (baseline 807, not grown). OPEN: 2 orphaned `logosctl watch storage_module --event storageDownloadDone` on node-b (reparented to systemd, started 12:49:34 during F2.1 live suites and 14:00:17 around the seller stop), a watcher-cleanup leak; manual seller is the only seller process |
| F3 | done (orchestrator, speed) | demo-results 'Live L run' generated from report.json (33/0/1); runbook live manual section; integration-report note; commands exist; no real URIs; diff --check 0 |
| F5.1 | done | parent plan: 29 boxes ticked, L10 network capture and T01 annotated open, status paragraph added |
| F5.3 gate | pass | npm test 584/585 (build-provenance 5s timeout under load; 2/2 alone), typecheck 0, build:clean 0, test:browser 30/30, cargo fmt 0, cargo clippy --locked -D warnings 0 (plan command; --all-targets fails on 16 pre-existing clone_on_copy/type_complexity lints in test code, clippy 0.1.98, not fixed), cargo test 101/0, diff --check 0 (after trimming EOF blank line), doctor 6/6, 0 logosctl watchers; seller stopped |
| F4 review | CHANGES REQUIRED -> fixed | 0 Critical, 3 Important fixed: (1) runbook integration commands now pass -c vitest.integration.config.ts; (2) demo-results Build line discloses two builds and which stages ran on the unrecorded second; (3) root cause of stop false failure was STOPPED_STATUSES missing 'not_running' (earlier 'exit code' diagnosis wrong) - RED unit case, fix, 21/21, real node-A stop exit 0 / start / infra:up / doctor 6/6. Minors 4-8 left open: demo-check addr_tm sanitizer boundary, sanitizeLiveInvoice cross-field checks, hardcoded adapter kinds in live-observe, L02/L06 evidence wording, tdd skill diagnosis |
