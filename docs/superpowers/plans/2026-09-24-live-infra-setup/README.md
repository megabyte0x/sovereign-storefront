# Live Test Infrastructure Setup — split plan (index, shared context, ledger)

This directory replaces the single-file plan `../2026-09-24-live-infra-setup.md`. The original stays in place as the design record: architecture, "why the previous stop is incorrect", the Logos docs-versus-needed analysis, and the self-review. **Execution now happens only from the files in this directory.**

Goal (unchanged): bring up every external dependency that plan Task 10 (live runtime assembly) and Task 12 (strict L demo) need on this machine. Prove each one with the repository's own live checks, then write one private `live.env` that Task 10 consumes.

## How execution works (read this first)

The single-file plan failed because one long session carried Task 2's full debugging history. The new rule is **one session per unit of work**:

1. **Task session (orchestrator).** For each top-level task, start a **fresh top-level Hermes session** in the worktree with the launch prompt below. That session is the task orchestrator. It reads only this README and its own `task-N/README.md`. It does not implement anything itself.
2. **Subtask session (worker).** For each subtask file, in order, the orchestrator spawns **one fresh subagent** (`delegate_task`, one task entry). The subtask file's full text is the subagent's `goal` and `context`. The worker has no memory of earlier subtasks, so every subtask file is self-contained.
3. **Wait and verify.** Subtasks are strictly sequential. `delegate_task` returns results asynchronously in this CLI: after it dispatches, the orchestrator ends its turn and waits for the result message. It does not poll. Then it re-runs the subtask's **Verify** commands itself. The worker's report is a claim, not evidence.
4. **Record.** The orchestrator updates the ledger below: one line per subtask, with its status and at most 3 lines of evidence. It never pastes logs. If a subtask comes back `blocked`, the orchestrator stops and asks the user. It does not start the next subtask.
5. **Close.** When every subtask of a task is `done` and the task-level Done check passes, the orchestrator marks the task `done` here and ends. The next task starts in a **new** session.

Why the orchestrator must be a top-level session: `delegate_task` children cannot delegate again. If an orchestrator were itself a child, it could not spawn workers.

### Launch prompt (paste into a fresh session, replacing N)

    Execute Task N of the live-infra plan as orchestrator. Read
    docs/superpowers/plans/2026-09-24-live-infra-setup/README.md and
    docs/superpowers/plans/2026-09-24-live-infra-setup/task-N/README.md and follow the
    "How execution works" protocol exactly: one fresh subagent per subtask file, sequential,
    verify each yourself, update the ledger, stop and ask me on any blocked result.
    Do not commit or push.

### Worker report contract (every subtask returns exactly this, ≤ 25 lines)

    status: done | blocked
    changed_files: [paths]
    commands_run: [command → exit code, one line each]
    evidence: [≤ 5 short lines: status words, heights, generations, prefixes; never secrets or full logs]
    deviations: [anything that differs from the subtask file, with the reason]
    blocker: <only if blocked: what is needed and from whom>
    notes_for_next_subtask: [≤ 3 lines]

### Context hygiene (applies to every session)

- Never `cat` launcher logs (`zcash/ths-start.log` contains the mnemonic and spending keys). Use `grep -c`, `tail -n 20` on non-secret logs only, or a targeted `grep` for an error word.
- Write long diagnostic output to `.runtime/live/diag/<subtask>-<timestamp>.log` (0600) and report only its path and a 1–3 line summary.
- Timebox each subtask as stated in its file. If the timebox is exceeded, return `blocked` with findings. Do not keep going.

## Shared context (every worker may rely on this)

- Worktree: `/home/megabyte/Work/zcash/eco-research/sovereign-storefront/.worktrees/live-mvp-integration` (branch `feat/live-mvp-integration`, large uncommitted diff; **do not commit, push, stash, reset or checkout**).
- Host: aarch64 Asahi Linux, Node 22, Docker, `ths` 0.2.1 at `~/.cargo/bin/ths`, `/usr/bin/chromium`.
- Specs: `docs/superpowers/specs/2026-09-23-live-mvp-integration-design.md`; parent plan `docs/superpowers/plans/2026-09-23-live-mvp-integration.md` (Tasks 8, 10, 12).
- Existing code (uncommitted, written in earlier sessions): `scripts/live-infra/{paths,doctor,zcash-up,zcash-down,logos-up,logos-down,waku-peers}.ts`, and `tests/unit/live-infra-{doctor,zcash,logos,waku}.test.ts`. `npm run infra:doctor` exists.
- Unit suite baseline: 33 files / 218 tests green, `npm run typecheck` clean (last checked 2026-09-24 before the pause).

## Global constraints (binding on every session)

- Authorizes infrastructure setup and live **checks** only. It does not authorize implementing plan Task 10, committing, pushing, modifying `ths` or upstream repositories, or using mainnet.
- Runtime state lives under `<worktree>/.runtime/live/` (gitignored), **except** the scanner directory. That moves to a short path in Subtask 2.1 because of the Unix-socket 108-byte limit. Directories are `0700`; config, log, env and key files are `0600`.
- `ths start` prints the disposable mnemonic and spending keys. Launcher output goes to a `0600` file only. Never print, paste or commit it. The UFVK goes only into a `0600` file path and never onto a command line.
- Owned resources: `ths` env `ssf-live`, the scanner PID in `serve.pid`, the Logos config dirs `.runtime/live/logos/node-{a,b}`. **Never** stop `ssf-task1`, `ssf-task3-live`, `default`, `p-happy`, or any non-owned container or process. (`ths start --name ssf-task3-live` is running on this host and is NOT owned.)
- Fixed ports: Logos A 18091/tcp and 18090/udp, Logos B 18191/tcp and 18190/udp. `ths` ports are random per start; always discover them with `ths endpoints --name ssf-live --json`.
- Unreachable means FAIL (with `SSF_STRICT_LIVE=1`) or SKIP (without it), and always carries a reason. It is never a synthetic PASS. Deterministic tests are never reported as live evidence.
- Append every concrete `ths` usability observation to `~/.hermes/skills/software-development/zakura-regtest/references/ths-dx-backlog.md`.
- Do not run reorg experiments.

## Runtime layout and `live.env` keys

Unchanged from the original plan (section "Runtime layout"), with one exception: after Subtask 2.1, `SSF_SCANNER_SOCKET` points under the short scanner dir defined in `scripts/live-infra/paths.ts` (`SCANNER_DIR`). The `live.env` keys are `SSF_MODE, SSF_NETWORK, SSF_SCANNER_SOCKET, SSF_SCANNER_ACCOUNT_ID, SSF_SCANNER_SOURCE_ID, LOGOSCTL, LOGOS_NODE_A, LOGOS_NODE_B, APPIMAGE_EXTRACT_AND_RUN, WAKU_BOOTSTRAP_PEERS, SSF_WAKU_CONTENT_TOPIC, THS_ENV_NAME`.

## Task map

| Task | File | Depends on | Subtasks |
| --- | --- | --- | --- |
| 1 Doctor + runtime layout | `task-1-doctor.md` | — | done (no subtasks) |
| 2 Zcash regtest + scanner | `task-2/README.md` | 1 | 2.1 → 2.2 → 2.3 → 2.4 |
| 3 Two Logos storage nodes | `task-3/README.md` | 1 (2 not required) | 3.1 → 3.2 → 3.3 |
| 4 Waku pinned peers | `task-4/README.md` | 1 | 4.1 → 4.2 |
| 5 One-command up/down + handoff | `task-5/README.md` | 2, 3, 4 | 5.1 → 5.2 → 5.3 |
| 6 Self-hosted Waku (optional) | `task-6-self-hosted-waku.md` | decision gate: user | spike only |

Tasks 3 and 4 do not depend on Task 2. They may run before Task 2 finishes, in their own sessions, but never at the same time as another task that edits `scripts/live-infra/paths.ts` or `live.env` merging.

## Ledger (orchestrators update this; one line per entry)

| Item | Status | Evidence (≤ 3 lines) | Date |
| --- | --- | --- | --- |
| Task 1 | done | `live-infra-doctor.test.ts` green; `npm run infra:doctor` wired | 2026-09-24 |
| 2.1 scanner socket path | done | paths/doctor/zcash tests 14/14 green, typecheck clean; SCANNER_SOCKET 82 bytes (~/.local/state/ssf-live/scanner) | 2026-09-24 |
| | | old-path serve PID 1419685 SIGTERMed (user-approved), exited in 1 s; old dir left for 2.4 | |
| 2.2 first green bring-up | done | zcash-up exit 0 first run; strict doctor zcash PASS, scanner PASS; live.env 0600 with 4 keys | 2026-09-24 |
| | | fixed doctor bug: scanner checkedAt is unix seconds, doctor compared ms → always stale; pollUntil now reports last error | |
| | | warm wallet-sync→scanner-ready 2.78 s (not a cold number); unit suite 34 files/231 tests | |
| 2.3 cold-start latency | done | scanner-only cold start step6 starting→ready: 2.018 s, 2.014 s (1 ECONNREFUSED poll, then ready) | 2026-09-24 |
| | | old 300–500 s was the ENOENT socket-path artifact; Step 6 deadline 900 s → 180 s (max(180 s, 3×2.018 s)), comment cites it | |
| | | no scanner instrumentation needed (services/scanner untouched); strict doctor zcash/scanner PASS; DX backlog appended | |
| 2.4 restart cycle + closeout | done | steps 1–4 covered by 5.3 down→up→down→up (all exit 0, leftovers=none); strict doctor 6/6 PASS (orchestrator re-run) | 2026-09-25 |
| | | old `.runtime/live/scanner/` removed (fuser: no users); 17 trace() calls carry no keys; wallet-scanner 5/5; DX backlog already had all 5 items | |
| | | gates: npm test 35 files/262 tests, typecheck, diff --check all 0 | |
| Task 2 | done | zcash + scanner PASS strict; zcash-up/down idempotent and restart-safe | 2026-09-25 |
| Task 3 | done | three Logos rows PASS in strict mode; nodes left running; storage IT ran (not skipped) | 2026-09-25 |
| 3.1 replication status handoff | done | doctor+logos unit 14/14, full suite 34 files/237 tests, typecheck clean (orchestrator re-run) | 2026-09-24 |
| | | proof → logos/replication.json (atomic 0600); pure replicationVerdict; stale reason `replication proof predates current daemons` | |
| | | deviation: daemon identity = `<node>/daemon/state.json` started_at#pid (alive check), not /proc stat; confirm on 0.2.3 in 3.2 | |
| 3.2 logos live bring-up | done | strict doctor: logos-a/logos-b/logos-replication PASS (waku FAIL = Task 4); unit 34 files/239 tests, typecheck clean | 2026-09-25 |
| | | logos-up exit 0 twice (idempotent); live.env +4 Logos keys, non-Logos lines unchanged; no smoke-* left; state.json pid/started_at present on 0.2.3 | |
| | | live fixes: daemon status exit 1 w/ JSON, catalog/install retries, downloadManifest before download, watch pgroup SIGKILL; sockets live in $TMPDIR (≤83 B) | |
| 3.3 logos teardown + storage integration | done | down→up cycle clean (pgrep empty, storage-data kept, doctor SKIP while down incl. "predates current daemons", 3×PASS after re-up) | 2026-09-25 |
| | | storage.test.ts live (orchestrator re-run): 2 passed, 0 skipped; strict doctor 3× Logos PASS; unit 34 files/244 tests, typecheck + diff --check clean | |
| | | fixed storage.ts (user-approved): subscribe watch before uploadUrl/downloadToUrl; download matched by sessionId. Task 8 gaps open: stop-origin fetch-from-B, 42-byte + tampered rejection, ctx.skip() on replica failure | |
| Task 4 | done | strict doctor `waku PASS` on pinned public peers (4 wss); strict IT 3/3 | 2026-09-25 |
| 4.1 waku SDK API verification | done | live-infra-waku 7/7, typecheck clean, no `any` (orchestrator re-run); pure `dialableFromPeers`; `--dry-run` writes nothing | 2026-09-25 |
| | | dry-run: connected=1 both_protocols=1 dialable=1; SDK shapes cited to .d.ts (node.waitForPeers, getConnections, peerStore.get→Peer) | |
| | | surprise: filter ID is `/vac/waku/filter-subscribe/…` (old `/filter/` match always gave 0); waitForPeers returns after 1 peer (risk vs MIN_PEERS=2) | |
| 4.2 waku live pinning + strict proof | done | waku_peers=4 cluster=1; peers.json 600 (dir 700), all wss; live.env +WAKU_BOOTSTRAP_PEERS, SSF_WAKU_CONTENT_TOPIC, 8 prior keys unchanged | 2026-09-25 |
| | | strict waku IT on pinned peers only (defaultBootstrap=false, src/adapters/waku.ts:68): 3× 1 passed/0 skipped — 8.49 s, 9.43 s, 9.75 s; no re-pin | |
| | | orchestrator re-run: strict doctor all 6 rows PASS, exit 0; live-infra-waku 10/10, typecheck clean; added pure pollDialable (2 s/90 s) + atomic peers.json write | |
| 5.1 up/down scripts | done | updown 7/7, typecheck clean (orchestrator re-run); unit 35 files/260 tests (worker) | 2026-09-25 |
| | | orchestrator `npm run infra:up` exit 0 idempotent: 6 rows PASS strict; down.ts free of non-owned env names | |
| | | extra pure helpers runStages/finalStatusLine/doctorRowLines/isLeftover (own PID+PPID excluded); down.ts not yet run live (5.3) | |
| 5.2 docs/live-infra.md | done | 110 lines, 8 sections; secret grep empty; all npm/script refs exist (orchestrator re-run) | 2026-09-25 |
| | | port hits only fixed Logos config 18090/18091/18190/18191 + ports quoted from public docs.logos.co node guide | |
| | | documents the 10 keys the code writes (SSF_MODE/SSF_NETWORK not written by any script) | |
| 5.3 E2E acceptance + handoff | done | down 2 s → up 42 s → down 34 s → up 44 s, all exit 0; both downs `leftovers=none`; non-owned diff empty | 2026-09-25 |
| | | orchestrator re-run: strict doctor 6/6 PASS exit 0; zcash+updown 15/15, typecheck + diff --check clean; worker: 35 files/262 tests, build:clean 0 | |
| | | fixed zcash-up: stale scanner.json after chain recreate made O_EXCL provision exit 1 → clearStaleScannerState (refuses while serving, 2 tests); Task 10 note at plan line 590 | |
| Task 5 | done | whole-plan Done met: 6/6 strict PASS, storage IT ran, strict waku IT on pinned peers, cycle clean | 2026-09-25 |
| Plan | done | Tasks 1–5 done; Task 6 remains user-gated; infra left running for Task 10 | 2026-09-25 |
| Task 6 | deferred | user decision 2026-09-25: self-host later; app stays on public cluster 1 | 2026-09-25 |

## Whole-plan Done

`SSF_STRICT_LIVE=1 npm run infra:doctor` exits 0 with zcash, scanner, logos-a, logos-b, logos-replication and waku all PASS from the current run. The Logos two-node integration test ran and was not skipped. The Waku strict integration test passed on pinned peers. A down→up→down→up cycle leaves nothing owned behind and comes back green. No secret appears in any tracked file, log excerpt or chat message.
