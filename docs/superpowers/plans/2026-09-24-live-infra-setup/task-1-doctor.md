# Task 1: Runtime layout and live-infra doctor — DONE

Status: done (2026-09-24). No orchestrator session is needed. This file records what exists so later workers can rely on it.

Produced (uncommitted):
- `scripts/live-infra/paths.ts`: `LIVE_ROOT` (absolute `<worktree>/.runtime/live`), `ensurePrivateDir(path)` (creates with 0700; throws on a symlink, a non-directory, or the wrong mode), and `mergeLiveEnv(record)` (atomic 0600 rewrite of `live.env`).
- `scripts/live-infra/doctor.ts`: `Row`, `RowId = 'zcash' | 'scanner' | 'logos-a' | 'logos-b' | 'logos-replication' | 'waku'`, `parseEnvFile`, `classify`, `summarize`, and a CLI that writes `LIVE_ROOT/status.json` (0600) and prints one line per row. Probes: `ths status` + `getblockchaininfo`; the scanner `/v1/snapshot` over the Unix socket (with a `withDeadline` wrapper and `content-length: 0`); `logosctl ... call storage_module debug`; replication from a status file; waku through the strict vitest run.
- `tests/unit/live-infra-doctor.test.ts`: 4 tests green.
- `package.json`: `"infra:doctor": "node --experimental-strip-types scripts/live-infra/doctor.ts"`.

Known issues owned by later subtasks (do not fix under Task 1):
- The scanner probe connects by the absolute `SSF_SCANNER_SOCKET` path and hits the same 108-byte limit. Fixed in Subtask 2.1.
- The `logos-replication` probe reads `LIVE_ROOT/status.json`, a file the doctor itself overwrites, and it expects `replication.run === 'current'`, which nothing writes. Fixed in Subtask 3.1.
