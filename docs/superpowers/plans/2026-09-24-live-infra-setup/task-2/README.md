# Task 2 orchestrator: Zcash regtest environment and live scanner daemon

You are the Task 2 orchestrator, running in a fresh top-level session. Follow the protocol in `../README.md` ("How execution works"). Do not implement anything yourself. Spawn one fresh subagent per subtask, in order, verify each result, and update the ledger in `../README.md`.

## Objective

A running `ths` env `ssf-live` and a running scanner `serve`, with `live.env` holding `SSF_SCANNER_SOCKET`, `SSF_SCANNER_ACCOUNT_ID`, `SSF_SCANNER_SOURCE_ID=ssf-live` and `THS_ENV_NAME=ssf-live`. The doctor shows `zcash PASS` and `scanner PASS` in strict mode. The scripts `scripts/live-infra/zcash-up.ts` and `zcash-down.ts` are idempotent and restart-safe.

## State at split time (2026-09-24 ~22:30)

- Running and owned: `ths start --name ssf-live --no-open` (PID in `.runtime/live/zcash/ths.pid`), and scanner `serve` (PID in `.runtime/live/scanner/serve.pid`). It is healthy when queried by a relative socket path.
- Running and NOT owned: `ths start --name ssf-task3-live`. Never touch it.
- `live.env` does not exist. No `zcash-up.ts` run has exited 0.
- Bugs already fixed in the code, so do not redo them: `Content-Length: 0` on bodyless GETs; re-provision `scanner.json` when the lightwalletd endpoint changes; skip init-view and serve when `alreadyServing`; `zcash-down` kills the `ths start` anchor PID; `fetchWithTimeout` and `req.setTimeout` on the poll calls; the 900 s Step 6 deadline; tracing gated by `ZCASH_UP_TRACE=1`.
- **Root cause of the ENOENT stall (confirmed during the split):** the socket path `<worktree>/.runtime/live/scanner/.scanner.json.live-state/scanner.sock` is 151 bytes, and Linux `sun_path` allows at most 108. The Rust scanner binds through a short `/proc/self/fd/N/scanner.sock` path, so the bind succeeds. Every client that connects by the absolute path gets ENOENT: `zcash-up`, `doctor`, and later the Task 10 adapter (`src/adapters/wallet-scanner.ts` requires an absolute path). A relative connect from inside the directory returned `200 complete=true health=ready`. This probably also explains why no run ever exited 0. The "300–500 s cold start" may be partly a misreading, which Subtask 2.3 re-measures.

## Subtasks (sequential)

| # | File | Timebox | Done means |
| --- | --- | --- | --- |
| 2.1 | `2.1-scanner-socket-path.md` | 60 min | Scanner state moved to a short dir; path-length guard unit-tested; old serve stopped |
| 2.2 | `2.2-first-green-bringup.md` | 60 min | `zcash-up.ts` exits 0; doctor zcash/scanner PASS in strict mode |
| 2.3 | `2.3-cold-start-latency.md` | 90 min | Measured cold-start time; the deadline is justified by a measurement or the cause is fixed |
| 2.4 | `2.4-restart-cycle-and-closeout.md` | 60 min | up→up (idempotent)→down (no orphans)→up green; gates green; DX backlog appended |

## How to dispatch each subtask

For subtask file F:

    delegate_task(tasks=[{
      goal: "Execute the subtask in <F>. Return the worker report contract from ../README.md.",
      context: <full text of ../README.md sections "Shared context", "Global constraints", "Worker report contract", "Context hygiene"> + <full text of F> + <notes_for_next_subtask from the previous report>
    }])

Then end your turn and wait for the result.

## Verify after each subtask (run these yourself; they are cheap)

- 2.1: `npx vitest run tests/unit/live-infra-paths.test.ts tests/unit/live-infra-zcash.test.ts` passes; `node --experimental-strip-types -e "import('./scripts/live-infra/paths.ts').then(m=>console.log(m.SCANNER_SOCKET.length))"` prints < 100; `pgrep -f "serve --config .*\.runtime/live/scanner/scanner.json"` is empty.
- 2.2: `SSF_STRICT_LIVE=1 npm run infra:doctor 2>&1 | grep -E '^(zcash|scanner) '` shows two PASS lines.
- 2.3: the ledger entry has a measured number of seconds, and `zcash-up.ts` has a deadline with a comment citing that measurement.
- 2.4: `docker ps --filter name=tsz-ssf-live -q` is empty after down; the doctor shows both rows PASS after the final up; `npm test && npm run typecheck` pass.

## Task 2 Done

Every subtask is done in the ledger. `SSF_STRICT_LIVE=1 npm run infra:doctor` shows `zcash PASS` and `scanner PASS` (the other rows may FAIL at this point). The environment is left **running** for Tasks 3–5. Mark Task 2 done in `../README.md` and end the session.
