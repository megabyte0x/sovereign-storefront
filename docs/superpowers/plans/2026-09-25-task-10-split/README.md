# Task 10 split plan: built live runtime (index, protocol, shared context, ledger)

This replaces the single "Task 10" section of `docs/superpowers/plans/2026-09-23-live-mvp-integration.md` for execution purposes. That section still holds the requirements (7 checkboxes and Done line). This directory decides who does each part, in what order, and how it is verified.

Why the split: the whole-task implementer stalled for hours on one model call. The slice-A fix round then ran for hours and stopped partway through Important #1. Each unit here is small enough for one fresh subagent inside a 45–90 minute timebox. Units whose files don't overlap run in parallel.

## How execution works (orchestrator protocol, read first)

1. **You are the orchestrator.** Run in a fresh **top-level** session so you can spawn subagents (a spawned child can't spawn its own). Read only this README and the subtask files you dispatch. Do not implement subtasks inline.
2. **One fresh subagent per subtask.** The subagent's context is: this README's sections "Shared context", "Global constraints", "Parallel-safety rules", "Worker report contract" and "Context hygiene", plus the full text of the subtask file, plus the `notes_for_next_subtask` from the reports it depends on. Extract the sections with `awk '/^## Shared context/,/^## Waves/' README.md` into a scratch file. Do not retype them.
3. **Waves.** Dispatch every subtask of a wave in **one** batch (parallel). Do not start the next wave until every subtask in the current wave is `done` and re-verified by you.
4. **Verify yourself.** A worker report is a claim, not evidence. When a worker returns, run its **Verify** block. At the end of a wave, also run the full gate: `npm test`, `npm run typecheck`, `git diff --check`. Parallel peers can leave each other's files half-written, so only the end-of-wave gate is authoritative.
5. **Record.** Add one ledger line per subtask below, with status and at most 3 lines of evidence. Never paste logs.
6. **Blocked.** If a worker returns `blocked`, don't retry it blindly. If the cause is a stuck model call (the transcript has been silent for more than 30 minutes, with no file changes and no report growth), stop the worker and re-dispatch the same file once. If it is anything else, stop and ask the user. Any other workers still running in the same wave can finish.
7. **Liveness.** On every continuation turn while workers run, check each worker's transcript mtime, `git status --short`, and the size of its report file. Workers must create their report file within the first 10 minutes and append to it after each step.

### Launch prompt (paste into a fresh top-level session)

    Execute Task 10 of the live MVP plan as orchestrator. Work in
    /home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/live-mvp-integration.
    Read docs/superpowers/plans/2026-09-25-task-10-split/README.md and follow its
    "How execution works" protocol exactly: dispatch each wave's subtask files as fresh
    subagents (Wave 3 as one parallel batch), verify each result yourself, update the
    ledger, and stop and ask me on any blocked result or after 3 failed review rounds.
    Do not commit or push. Do not run infra:down/infra:up.

## Waves

    Wave 1 (serial)    10.1 readiness cache            -> finishes slice-A fix round 1
    Wave 2 (serial)    10.2 scoped re-review (read-only) -> fix loop if Critical/Important
    Wave 3 (parallel)  10.3 CSP + static serving + log hygiene     (server.ts, log.ts)
                       10.4 shutdown + start:live + main.ts         (scripts/start-live.ts, main.ts, package.json)
                       10.5 admin publish route + command + docs    (src/seller/admin-publish.ts, scripts/publish-live.ts, docs/*)
                       10.6 deferred review minors                  (config.ts, adapters/live.ts, adapters/waku.ts, runtime.ts)
    Wave 4 (serial)    10.7 built-subprocess live proof (uses the live stack)
    Wave 5 (serial)    10.8 whole-Task-10 review (read-only) -> fix loop -> close

| # | File | Timebox | Depends on | Done means |
| --- | --- | --- | --- | --- |
| 10.1 | `10.1-readiness-cache.md` | 60 min | — | 3 RED readiness tests GREEN; full suite 294/294 |
| 10.2 | `10.2-fix-round-rereview.md` | 30 min | 10.1 | Reviewer: no open Critical/Important on slice A |
| 10.3 | `10.3-csp-static-logs.md` | 60 min | 10.2 | CSP from configured peers; explicit dist/browser; log allow-list tests |
| 10.4 | `10.4-shutdown-start-live.md` | 75 min | 10.2 | SIGINT/SIGTERM unwind test; `npm run start:live` exists |
| 10.5 | `10.5-publish-command-docs.md` | 75 min | 10.2 | `POST /admin/products` handler + `publish-live` command; `docs/live-runtime-config.md` |
| 10.6 | `10.6-review-minors.md` | 60 min | 10.2 | Minors 1,2,4,5,6,7 from `task-10a-review.md` fixed with tests |
| 10.7 | `10.7-live-subprocess-proof.md` | 90 min | 10.3–10.6 | Compiled `dist/service/main.js` ran against the live stack; the checkbox-7 evidence is recorded |
| 10.8 | `10.8-final-review-close.md` | 45 min + fixes | 10.7 | Task 10 review clean; plan checkboxes ticked; progress ledger updated |

## Decisions already made (do not re-ask the user)

- **Commits are withheld.** Everything stays uncommitted in this worktree. Review packages come from the working tree (see 10.2). The user commits by hand later.
- **The slice-A fix round is finished, not restarted.** Critical #1 and Important #2 already have RED and GREEN evidence (`task-10-report.md`, "Fix round 1"). Only Important #1 remains, and that is 10.1.
- **The 9 minors from `task-10a-review.md` are not deferred to the end.** They are split by file ownership: minor 3 goes to 10.3 (it lives in `server.ts`), minor 8 to 10.4 (`main.ts`), and minors 1, 2, 4, 5, 6 and 7 to 10.6. Minor 9 needs no code change beyond what 10.4 and 10.5 already do.
- **Default live paths** (used by 10.4, 10.5 and 10.7):
  - `SSF_SCANNER_CONFIG` defaults to `SCANNER_JSON` from `scripts/live-infra/paths.ts`.
  - The admin token is `.runtime/live/seller/admin.token` (0600), created by `start:live` with `umask 077` if it is missing. It is never printed.
  - `SSF_DB_PATH` is `.runtime/live/seller/seller.sqlite`, in a 0700 dir. The caller's env overrides any of these.
- **There is no HTTP publish route today** (the admin server serves only `/admin/health`). 10.5 builds the handler in a new module. After Wave 3, the orchestrator wires it into `server.ts` with one line. The same goes for any other one-line cross-file wiring a Wave 3 worker reports under `deviations`. Apply all of them, then run the end-of-wave gate.
- **Parallel workers share this one worktree.** There are no per-task git worktrees, because the plan forbids commits and a sibling worktree can't see uncommitted work. Isolation comes from strictly disjoint file lists (below).

## Shared context

- Worktree: `/home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/live-mvp-integration`, branch `feat/live-mvp-integration`. It carries a large uncommitted diff from earlier tasks. **Do not commit, push, stash, reset, checkout or revert any file you do not own.**
- The requirements come from `docs/superpowers/plans/2026-09-23-live-mvp-integration.md`, section "Task 10: Assemble the built live runtime and startup gates", including its "Facts Task 10 must build on" bullets. Read **only** that section of the plan and none of the others.
- SDD workspace (gitignored): `.superpowers/sdd/2026-09-23-live-mvp-integration/`. `task-10a-review.md` is the slice-A review and lists the findings by number. `task-10-report.md` is the slice-A report plus the partial fix round 1. `progress.md` is the ledger.
- Slice A already exists and is uncommitted:
  - `src/adapters/live.ts` has `createLiveAdapters` and a WeakMap brand.
  - `src/runtime.ts` has `startRuntime`, `RuntimeFactories`, the loops, `refreshReadiness`, and `stop` with its unwind.
  - `src/config.ts` has `parseLive`, `LiveConfig` and `MissingLiveKeyError`.
  - `src/seller/messages.ts` has the outage-safe `status`/`recover` handling and the catch-all in `attachSellerApplication`.
  - Parts of `src/seller/server.ts` and `src/main.ts` are modified.
- Suite at split time (2026-09-25 18:12): `npm test` is 291 passed and 3 failed, 294 total in 37 files. The 3 failures are the intended RED readiness tests at `tests/unit/live-composition.test.ts:427-520`. Anything else failing is a regression.
- Real-demo config needs `SSF_MODE=real-demo`, `SSF_NETWORK=regtest`, `SSF_ADMIN_TOKEN_FILE` (0600) and `SSF_SCANNER_CONFIG` (0600, the scanner's `scanner.json`). It also needs the keys in `.runtime/live/live.env`. It rejects an inline `SSF_ADMIN_TOKEN`, `SSF_SELLER_KEY_ID` and any raw consensus digest.
- Test patterns to reuse:
  - The `liveConfig()` and `harness()` helpers in `tests/unit/live-composition.test.ts`.
  - The fake `WakuNode` routed through real ECIES (`makeFakeNode`, `tests/unit/waku.test.ts`).
  - Test-local factories passed to `startRuntime(config, factories)`.
- Host: aarch64 Linux, Node 22, `/usr/bin/chromium`. Live stack: `npm run infra:up`, `npm run infra:down` and `SSF_STRICT_LIVE=1 npm run infra:doctor` (6 rows: zcash, scanner, logos-a, logos-b, logos-replication, waku). It was left running.

## Global constraints

- Every code change follows RED → GREEN → focused regression → self-review. Record the RED failure line and the GREEN summary line in your report.
- No process-global mutable test hooks in production modules. Seams are per-instance options or factories.
- No fixture or memory adapter may be reachable from real-demo composition. Never call a deterministic test "live evidence".
- Secrets (admin token, UFVK, scanner config contents, seller private key, mnemonic) never appear in logs, reports, command arguments, browser config or git.
- Only 10.7 may touch the live stack, and only as a client plus its own seller subprocess. **Nobody runs `infra:down`, `infra:up`, `ths stop` or kills any process they did not start.** Never touch the `ths` envs `ssf-task1`, `ssf-task3-live`, `default` or `p-happy`.
- Unix-socket paths must be at most 100 bytes (Linux `sun_path` is 108).
- The scanner's `checkedAt` is in Unix seconds. Convert it to ms once, at the adapter boundary (this is already done in `live.ts`).
- Global limits: 10 confirmations, health age at most 120000 ms, plaintext at most 41 bytes and ciphertext at most 73 bytes.

## Parallel-safety rules (binding in Wave 3)

- Edit **only** the files listed under "Owns" in your subtask. If you need a change in a file you don't own, stop and describe it under `deviations`. Do not make it.
- Put new tests in **new** test files named in your subtask. Do not edit shared test files unless your subtask names them.
- Run focused tests only: `npx vitest run <your test files> <named regression files>`. For typecheck, run `npx tsc --noEmit` and act only on errors in files you own. Errors in a peer's files are expected mid-wave; mention them and don't fix them.
- Do not run `npm run build`, `npm run build:clean` or `npm install` during Wave 3. `dist/` and `node_modules/` are shared, and only 10.7 builds.
- Only 10.4 edits `package.json`. No subtask edits the lockfile.

## Worker report contract (return exactly this, at most 25 lines)

    status: done | blocked
    changed_files: [paths]
    commands_run: [command -> exit code, one line each]
    red: [the failing assertion line(s) before the fix]
    green: [vitest summary line(s) after the fix]
    evidence: [<= 5 short lines; never secrets or full logs]
    deviations: [anything that differs from the subtask file, with the reason]
    blocker: <only if blocked: what is needed and from whom>
    notes_for_next_subtask: [<= 3 lines]

Also write the same report, appended incrementally, to `.superpowers/sdd/2026-09-23-live-mvp-integration/task-<id>-report.md` (for example `task-10.3-report.md`). Create that file within 10 minutes of starting.

## Context hygiene

- Do not read the whole parent plan. Read only its Task 10 section and the files your subtask names.
- Write the RED test within about 15 minutes of starting.
- Never `cat` `.runtime/live/zcash/ths-start.log`, `live.env` values, `scanner.json` or any token file. `cut -d= -f1` for keys and `stat -c %a` for modes are fine.
- Long output goes to `.runtime/live/diag/10.x-<timestamp>.log` (0600). Report only its path and a 1–3 line summary.
- If you exceed the timebox, return `blocked` with your findings. Do not keep going.

## Ledger (orchestrator appends one line per event)

| Subtask | Status | Evidence (≤ 3 lines) |
| --- | --- | --- |
| baseline | recorded | 2026-09-25 18:12: `npm test` 291 pass + 3 RED (live-composition 427/471/492); slice-A Critical #1 and Important #2 GREEN, unreviewed |
| 10.1 | done | 2026-09-25 18:36 orchestrator re-verify: live-composition 10/10; `npm test` 294/294 (37 files); typecheck + `git diff --check` clean |
| | | `verifyReplica` only in `refreshReadiness` (runtime.ts:297, bounded); catalogue.ts:148/221 are fallbacks used only when `replicaReady` is absent; runtime always passes it |
| | | deviations: test 3 `_started` hack → `state.started`; `scannerSocket()` helper reuses the listening socket (EADDRINUSE); no assertion weakened |
| 10.2 | done | 2026-09-25 18:45 `task-10a-fix1-review.md`: Critical #1, Important #1, Important #2 all ADDRESSED; new issues C0/I0/M3; `Verdict: clean` |
| | | carried to 10.8: M1 timed-out replica probe keeps holding the replica lock ≤90 s (skip re-probe while pending or abort); M2 status reconcile swallows all errors unlogged; M3 test 3 first `stop()` not in `finally` |
| | | note: `demo-check` `main()` still sets inline `SSF_ADMIN_TOKEN`/`SSF_SELLER_KEY_ID`, so real-demo preflight reports adapters FAIL until slice B |
| Wave 3 | re-dispatch | 2026-09-25 20:22: all 4 workers (deleg_ffc8c4c3) silent since 18:46 with no file changes and stub reports only; stopped and re-dispatched each once per protocol step 6 |
| 10.3 | done | 2026-09-25 20:50 csp-static/log-allowlist/security/logs green; `process.cwd()` only in fixture branch of `resolvePublicDir` (server.ts:95-97); no `connect-src *`/`'wss:'` |
| | | deviations: allow-list adds `loop`/`method`, drops `path` (http events no longer log request path); `/tls/ws` peers map to `wss://` |
| 10.4 | done | 2026-09-25 20:50 main-shutdown + start-live green; `package.json` diff is the single `start:live` line; `runMain` only runs when main.ts is the entrypoint |
| 10.5 | done | 2026-09-25 20:50 admin-publish + publish-live green; orchestrator probe on fixture `startSeller`: unauth 401, auth 201 (`replica=true`), `/api/product` 200 |
| | | doc secret grep empty; every `npm run`/`scripts/` reference in `docs/live-runtime-config.md` and `docs/runbook.md` exists |
| 10.6 | done | 2026-09-25 20:50 review-minors/config/live-composition/waku/waku-transport green; no `sellerKeyId: ''` in config.ts; minor 1 via SDK `isConnected()` (no faked connectivity) |
| Wave 3 gate | done | orchestrator wiring: runtime `publicDir` factory → startSeller; main.ts passes `dist/browser`; server.ts narrows `sellerKeyId` (after CSP/publicDir checks) + mounts `POST /admin/products`; log.ts allows `admin.publish` |
| | | test fixups: live-composition harness passes a scratch `browser/index.html`; csp-static real-demo limits 73/41 (10.6 cap) and explicit `sellerKeyId` |
| | | `npm test` 353/353 (44 files); `tsc --noEmit` 0; `git diff --check` 0 |
| 10.7 | done | 2026-09-25 21:00 orchestrator re-run: live-runtime 7/7 (0 skipped) against compiled dist/service/main.js; readiness `scanner=true messaging=true`, publish → storageReplica=true, sellerKeyId 04e2c16c67c1… = persisted identity across restart; disabled routes 404; CSP 4 wss, no `*` |
| | | SIGTERM exit 0 < 1 s, ports freed, leak ps empty; doctor 6 PASS after; `npm test` 364/364 (47 files); tsc + `git diff --check` clean |
| | | live bugs fixed (review in 10.8, outside listed files): start-live now sets real-demo caps; waku.ts `withLibp2pConnectivity` (Node 22 lacks `navigator.onLine`); storage.ts replica connects by loopback multiaddr + retries "Failed to start download." |
| 10.8 review 1 | needs fixes | 2026-09-25 21:07 `task-10-final-review.md`: C0/I1/M6; checkboxes 1-5,7 met, 6 not met. I1: runtime never closes LiveStorage (not in stop list, runtime.ts:250-294) and `downloadAndWait` leaves `download-*.ssf1`; 92 leaked `$TMPDIR/ssf-logos-*` dirs |
| | | 10.7 live fixes judged sound (caps equal config caps; libp2p connectivity is real; replica retry bounded to 4 on one error). Minors: M1/M2/M3 open, m4 no min on `SSF_MIN_CONFIRMATIONS` in real-demo, m5 admin token compare not constant-time, m6 start:live stdout mixes JSON events |
| | | fix round 1 dispatched: I1 + M3 + m4 |
| 10.8 fix 1 | re-review | 2026-09-25 21:15: storage registered first (stop order core, waku, scanner, storage; on every partial start too); `downloadAndWait` removes its file in `finally`; real-demo min confirmations 10 |
| | | orchestrator: `npm test` 371/371 (48 files); tsc, build, `git diff --check` clean; live-runtime re-run 7/7, `$TMPDIR/ssf-logos-*` count unchanged (917 → 917); doctor 6 PASS |
| 10.8 | done | 2026-09-25 21:20 fix-1 re-review `task-10-final-fix1-review.md`: I1, M3, m4 ADDRESSED; new C0/I0/M2 (n1 no real-demo cap on `SSF_INVOICE_TTL_MS`; n2 storage logs `started` early); `Verdict: clean` |
| | | accepted minors: M1 replica lock ≤90 s, M2 unlogged reconcile errors, m5 non-constant-time token compare, m6 mixed start:live stdout, n1, n2. Parent plan's 8 Task 10 boxes ticked with evidence pointers (the split counted 7) |
| Task 10 | done | `npm test` 371/371 (48 files); typecheck, build, `git diff --check` clean; live-runtime 7/7 against compiled `dist/service/main.js`; `progress.md` close entry written; uncommitted |

## Task 10 Done

Every subtask above is `done`. Both 10.2 and 10.8 have no open Critical or Important findings. `npm test`, `npm run typecheck`, `npm run build` and `git diff --check` pass. 10.7's evidence shows the **compiled** `dist/service/main.js` running against the live stack, with the readiness, `/api/product` identity, disabled-route and restart/no-leak checks observed. Every Task 10 checkbox in the parent plan is ticked with a one-line pointer to its evidence. `progress.md` records the close.
