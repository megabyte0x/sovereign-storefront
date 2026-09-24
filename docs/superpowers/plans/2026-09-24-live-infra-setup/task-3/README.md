# Task 3 orchestrator: Two local Logos Storage nodes (origin A, replica B)

You are the Task 3 orchestrator, running in a fresh top-level session. Follow the protocol in `../README.md`. Spawn one fresh subagent per subtask, in order, verify each yourself, and update the ledger.

## Objective

Two running `logosctl` 0.2.3 daemons, each with `storage_module` 2.1.2 started, with distinct peer IDs and ports 18091/18090 (A) and 18191/18190 (B). A current-run replication proof (upload on A, download on B, SHA-256 match) that the doctor can read. `live.env` holds `LOGOSCTL`, `LOGOS_NODE_A`, `LOGOS_NODE_B` and `APPIMAGE_EXTRACT_AND_RUN=1`. The existing storage integration test runs and is not skipped.

## State at split time

- `scripts/live-infra/logos-up.ts` (346 lines) and `logos-down.ts` exist. `tests/unit/live-infra-logos.test.ts` passes 2/2. **They have never run against this worktree.**
- The logic was reverse-engineered against the real CLI in a scratch dir. Known deviation from the original plan: `connect <peerId> json:[]` fails on loopback-only nodes; the code already uses the explicit `/ip4/127.0.0.1/tcp/<port>/p2p/<peerId>` multiaddr.
- The verified archive exists at `.worktrees/feat-mvp-t2/spikes/storage/runtime/logosctl-aarch64-linux.tar.gz` (sibling worktree under the main repo). `logos-up.ts` resolves it as `SPIKE_ARCHIVE`.
- **Known defect (Subtask 3.1):** `logos-up.ts` writes replication evidence to `LIVE_ROOT/logos/status.json` without a run marker. `doctor.ts` reads `LIVE_ROOT/status.json`, which is its own output file and is overwritten on every doctor run, and expects `replication.run === 'current'`. The `logos-replication` row therefore cannot PASS today.
- Socket-length check: Logos config-dir paths are about 118 bytes. If logosctl uses a Unix socket inside the config dir, it may hit the same 108-byte limit as the scanner did (Task 2). Subtask 3.2 checks this first.

## Subtasks (sequential)

| # | File | Timebox | Done means |
| --- | --- | --- | --- |
| 3.1 | `3.1-replication-status-handoff.md` | 45 min | The replication proof file and doctor contract are fixed and unit-tested |
| 3.2 | `3.2-logos-live-bringup.md` | 90 min | `logos-up.ts` exits 0; doctor logos-a, logos-b and logos-replication PASS |
| 3.3 | `3.3-teardown-and-storage-integration.md` | 60 min | down→up cycle clean; `tests/integration/storage.test.ts` ran, not skipped |

Dispatch the same way as described in `../task-2/README.md` ("How to dispatch each subtask").

## Verify after each subtask

- 3.1: `npx vitest run tests/unit/live-infra-logos.test.ts tests/unit/live-infra-doctor.test.ts` passes.
- 3.2: `SSF_STRICT_LIVE=1 npm run infra:doctor 2>&1 | grep -E '^logos'` shows three PASS lines.
- 3.3: after `logos-down.ts`, `pgrep -af "logos/node-(a|b)"` is empty. After the final `logos-up.ts`, the doctor again shows three PASS lines. The report quotes the vitest summary for `storage.test.ts` with skipped = 0.

## Task 3 Done

Every subtask is done in the ledger. The three Logos doctor rows PASS in strict mode. The nodes are left **running**. Mark Task 3 done in `../README.md`.
