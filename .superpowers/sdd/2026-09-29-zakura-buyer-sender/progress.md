# SDD ledger — plan: docs/superpowers/plans/2026-09-29-zakura-buyer-sender/README.md

Orchestrator: this session. Grants: no commits, no push. Base HEAD 23db043 (97 dirty paths pre-existing).

## Preflight conflict scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| 1.2 ↔ 2.1/4.1 | main.rs mod lines | orchestrator adds `mod chain;`/`mod pay;` between waves (README note) |
| 3.1 ↔ 4.2/4.3 | main.rs | serial waves, OK |
| 5.1 ↔ 5.2 | runPublicT01Wallet(['resolve']) | 5.2 uses only existing export + new command; OK |
| 5.1 ↔ 6.2 | test file rewrite | tests break between Wave 3 and 6; expected |
| 6.2 ↔ baseline | public-t01.test.ts | pre-existing failure 'display byte order' (see P0) — not caused by this plan |
| parent 4.2 vs C2 | digest trim | C2 rules no trim; applied |
| 4.3 probe | tx-status 64-zero txid | read-only network, allowed |

Ruling: pre-existing public-t01.test.ts failure ('a wallet txid in display byte order…', expected 1 to be 0) is out of scope; 6.2 owns the file and may fix it only if the cause is test-side — cost if wrong: one unrelated red test stays red.

## Rows
- P0: done — HEAD 23db043, 97 dirty; vitest 724 pass/1 fail (pre-existing public-t01 display-txid); tsc 0; diff-check 0; scanner cargo 110 pass; no tools/buyer-sender, no ~/.local/state/ssf-buyer; all exports pub; scanner baseline diff 1125 lines.
- 1.1: dispatched deleg_03f7140d sa-0-c2039bc1
- 1.1: done (orchestrator re-verified) — cargo check --locked 0; cargo tree -d crypto dup count 0; zakura lock diff empty; scanner diff identical to P0 snapshot. Lock adds only bip39 + 3 leaf deps.
- 1.1 deviation applied by orchestrator: .gitignore += tools/buyer-sender/target/
- 1.2: dispatched
- 1.2: done (orchestrator re-verified) — build 0, 0 warnings; probe status -> not implemented exit 2, dir 700; package.json +1 line.
  Ruling: accept 1.2 deviations (global flags also accepted after the command; StateDir opened+flocked in dispatch before handlers; open_root mkdir-0700 fallback when parent is 0755; temporary #![allow(dead_code)] in state.rs to be removed by 4.3) — they keep the frozen contract and lock-for-whole-command; cost if wrong: minor parser/review churn.
- Wave 3 (2.1 ‖ 5.1 ‖ 5.2): dispatched
- Wave 3: done (orchestrator re-verified) — sender build 0 warnings; 3 scripts smoke-load 0; zingo/nym grep empty; tsc errors only 9 in tests/unit/public-t01-wallet.test.ts (expected until 6.2); diff-check 0.
  Ruling: accept 5.1 deviations (spawn failure=127 treated as nothing broadcast; 'no attempt recorded' removes a record only if it has no txid; unknown pay exits take the 3/4 path; resolvePending called only when a pending record exists) — all conservative; cost if wrong: an extra resolve call.
  Ruling: accept 5.2 deviations (README CUA paragraph reworded; walletSend/WalletSendOptions exported as test seam; expired stops poll early -> ambiguous, never resends) — cost if wrong: doc wording.
  Note for 4.3: chain::tx_status arg order is (client, txid, expiry, tip).
- Wave 4 (3.1 ‖ 4.1): dispatched
- Wave 4: done (orchestrator added `mod pay;`, re-verified) — build 0 errors/0 warnings; probe status -> 'wallet is not imported' exit 2.
  Ruling: accept 3.1 deviations (import opens existing wallet with stored seed for the already-imported check; account missing from summary -> 'wallet is not synchronized') and 4.1 deviations (O_NOFOLLOW regular-file check, extra 'invoice file could not be read' error) — cost if wrong: error-string churn.
  Carry to review: chain.rs lines ~222/236 not rustfmt-clean (Minor).
- 4.2: dispatched
- 4.2: done (orchestrator re-verified) — build 0 warnings; pay.rs order guard:194 -> connect:216 -> write_attempt:308 -> broadcast:312; no raw_hex/to_uri/encode in main.rs.
  Ruling: accept CommandResult = Result<(Value, exit), (exit, err)> so pay can print JSON with exit 3/4 — cost if wrong: signature churn in 6.1.
  Ruling: accept warmup via bundle_version_for_branch(...).circuit_version() (rc5 has no direct helper) — cost if wrong: slower first proof, not correctness.
- 4.3: dispatched
- 4.3: done (orchestrator re-verified) — -D warnings build 0; no allow(dead_code) left; live read-only probe: 64-zero txid -> NOT_FOUND -> expired exit 0; rebroadcast of expired -> exit 2.
  Carry to review: tx-status connect/tip failures exit 2 (not 3); TS resolvePending treats any nonzero other than 'no attempt recorded' as stay-pending — check consistency.
- Waves 1-5 (dev) complete.
- Wave 6 (6.1 ‖ 6.2): dispatched
- 6.1: blocked only on 3 clippy lints in non-test code (main.rs &PathBuf x2, pay.rs drop_non_drop); orchestrator applied fully specified fixes (&Path; spending keys scoped to an inner block) + rustfmt main.rs. 29 Rust tests pass.
- 6.2: done — 32 wallet tests + 13 public-t01 tests; the pre-existing 'display byte order' failure was a test-fixture bug (paymentState keyed TX(n) vs internal(n)), fixed in the test; no script edits.
- G gates: vitest 87 files / 736 pass / 0 fail (P0 was 724+1 fail); tsc 0; diff-check 0; clippy --all-targets -D warnings 0; cargo test 29 pass; scanner 108 pass (P0 also 108 — earlier '110' in my summary was a miscount); cargo tree crypto dups 0; scanner diff identical to P0; zingo/nym grep empty; 3 scripts smoke-load 0; rustfmt clean.
- R: package .runtime/public/diag/buyer-sender-review.diff (4540 lines, 0 long utest1 strings); reviewer dispatched.
- R: needs fixes — 0 Critical, 4 Important (I-1 dir fsync after attempt write; I-2 TS allows re-pay of expired digest; I-3 unreadable attempt file exits 2 -> TS deletes record; I-4 Attempt derives Debug with raw_hex), 7 Minor. Report reports/R.md.
  Ruling: fix round 1 includes all 4 Important plus Minors M1 (tx-status connect/tip failures exit 3 once an attempt exists), M2 (TS checks attemptId == digest before adopting txid), M3 (exit-4 test fixtures print attempt shape) — cheap and on the no-second-tx path. Carried Minors (not fixed): explicit --state-dir, single-endpoint NOT_FOUND trust, no TS ledger lock, CLI send --uri on argv (pre-existing). Cost if wrong: small extra diff.
  Ruling on I-2: an `expired` record blocks a new send of the same invoice digest (message: request a new invoice); the plan's 5.5/6.2 line 'a later send of the same invoice is allowed' is superseded because the binary keeps the attempt file and would exit 4 forever.
- Fix round 1: dispatched
- Fix round 1: fixer done (34 Rust tests). Orchestrator gates: cargo test 34/34, clippy 0, fmt 0, -D warnings build 0, scanner unchanged, diff-check 0, vitest 87/742 pass, tsc 0, smoke 0.
  Ruling: accept fixer deviations (dir fsync via /proc/self/fd reopen; attempts/ open failure and 'attempt file is invalid' -> exit 3; fsync failure removes file and refuses exit 2 before broadcast) — all move toward 'unknown' on doubt; cost if wrong: more pending records needing resolve.
- Re-review fix1: dispatched (package .runtime/public/diag/buyer-sender-fix1-review.diff)
- Fix round 1/5: re-review RR1 — 6 addressed (I-2,I-3,I-4,M1,M2,M3), 1 open (I-1 partial: root fsync skipped because pay_guard's read_attempt creates attempts/ first). Deferred Minors D1 (rebroadcast past expiry exit 2), D2 (unlink after failed fsync not synced), D3 (fresh-root attempts/ create failure exit 3 leaves txid-less pending), D4 covered by round 2.
- Fix round 2: dispatched (I-1 remainder + D4 test)
- Fix round 2/5: I-1 remainder addressed — attempts() fsyncs the root whenever it creates attempts/ (state.rs:271-290), D4 test added; orchestrator gates: cargo test 35/35, clippy 0, fmt 0, -D warnings build 0.
  Ruling: orchestrator verified the ~15-line fix2 diff directly instead of a third re-review dispatch (sync_dir_of opens /proc/self/fd/N = state root and sync_all; failure maps are unchanged) — cost if wrong: an unreviewed durability edge on first pay.
- R (Wave 7): complete, 2 fix rounds, 0 open Critical/Important. Deferred Minors: R explicit --state-dir; single-endpoint NOT_FOUND trust; no TS ledger lock; CLI send --uri on argv (pre-existing); RR1 D1 rebroadcast-past-expiry exit 2; D2 unlink after failed fsync unsynced; D3 fresh-root attempts/ create failure exit 3; chain.rs rustfmt nit (resolved by later rustfmt).
- Wave 8 precondition: holds (buyer-sends statuses expired x4 + sent; t01-run.json a.send=sent, no b; no public-t01/zingo-cli processes). Awaiting user go-ahead (live seed + testnet funds).
- User 2026-09-29: go-ahead for all of Wave 8; keeps I-2 ruling (expired invoice needs a new invoice).
- 8.1 INCIDENT: a structural-inspection regex left the LAST seed word of the zingo buyer phrase unmasked in session output (1 of 24 words; no key/UFVK/address printed). Disclosed to the user. Testnet-only wallet.
- 8.1: done — import exit 0 in 47 s ({birthday 4407805, tip 4414458}); temp mnemonic file shredded; state dir 0700, seed/wallet/lock 0600. status 2 s: ironwoodZat 9,890,000 = 10,000,000 − 100,000 (purchase A) − 10,000 fee; orchard 0.
  Key parity: zingo export_ufvk (clearnet, --nosync) vs UFVK from seed.private, compared inside a scratch example printing only verdicts: orchard=equal, sapling=equal; transparent not compared (crate built without transparent-inputs). Example and the 0600 zingo UFVK file deleted/shredded.
  Ruling: component equality replaces the plan's whole-UFVK sha256 comparison — the digests differed because zingo's UFVK encoding includes a transparent component the sender does not derive; funds live in Orchard/Ironwood, which match. Cost if wrong: none for spending (balance parity also holds).
- 8.2: preflight started
- 8.2: BLOCKED (not a sender defect) — T01 run exit 1 at purchase A 'three-confirmations' after the 45 min budget; no buyer-sender pay was invoked (attempts/ empty, ledger unchanged, no TAZ spent on B).
  Evidence: seller scanner has A's ironwood receipt 100000 zat at 908 confirmations; browser payment label not 'Paid'; seller DB delivery_state for A = queued; seller log runtime.loop dispatch ok:false code Error on every tick (198 consecutive) since just after A was sent. Probes: .runtime/public/diag/probe-{conf,label,label2}.mts (label2 timed out, harmless).
  Awaiting user decision: investigate/fix the VPS seller dispatch error vs stop.
- 8.2 seller investigation (user chose: investigate, fix with test, redeploy, rerun T01). Read-only findings:
  - Seller readiness flipped to false at 2026-09-29T03:17:02Z and has stayed false since (2687 consecutive ticks); container never restarted (StartedAt 2026-09-28T22:07:49Z, RestartCount 0).
  - Seller netns has ZERO TCP connections to any Waku peer (only the tailnet replica agent). All 3 bootstrap peers accept TLS on :8000 from inside the container right now.
  - dispatch fails ~505 ms per tick = 3 lightPush attempts x 250 ms -> 'delivered to zero peers'. 209 delivery_attempts for A, all outcome NULL; delivery_state queued.
  - Root cause (code): createWakuSession.ensureStarted() returns the cached node whenever node && started, so once libp2p loses every peer the session never redials or recreates the node; ready() and send() fail forever until a process restart.
  - Fix plan: TDD in src/adapters/waku.ts - when the cached node reports no connections, stop it and recreate it (bounded), covered by a fake-node test; then full gates, rebuild seller image on VPS, restart seller, confirm A delivers, rerun T01.
- 8.2 seller fix: RED 4/5 in tests/unit/waku-reconnect.test.ts -> GREEN after ensureStarted() replaces a peerless node (single shared start, best-effort retire). Gates: vitest 747/747, tsc 0, diff-check 0, build 0. dist diff vs VPS: only adapters/waku.js(+map) and browser html asset hash.
  Deploy: full seller image rebuild failed (Docker Hub token fetch timed out over IPv6); built ssf-seller:amd64 (5a3b0b1489fb) as overlay FROM ssf-seller:amd64-prev-20260929 + COPY dist. Rollback: /srv/ssf/build/dist-prev-20260929 and image tag amd64-prev-20260929. Restarted seller only (--no-deps) 12:38:55Z: healthy, ready messaging=true, 0 dispatch failures.
  Purchase A delivery: transport-accepted, delivery_state sent_unacknowledged. Rerunning T01 run.
- 8.2 run2-4: A three-confirmations PASS on the fixed seller (delivery acknowledged). Stuck at bytes-match: system Chromium 153 (/usr/bin/chromium) segfaults/SIGTRAPs in headless mode when the page starts the .bin download (coredumpctl 18:11, 18:26, 18:27, 18:31, 18:36, 18:37); poll() swallows the error and retries until its 45 min budget. Isolated with probes: page shows Paid and download starts; driver.download() alone passes, purchase()+download() in one context crashes.
  Fix (harness only): scripts/public-t01-live.ts executablePath now honours SSF_T01_CHROMIUM (default unchanged). With Playwright's bundled chrome-headless-shell-1243 the same purchase()+download() sequence returns sha cdf8ad2aad68 = fixture, no crash. Runs 3 and 4 were stopped by me (cmdline-checked SIGTERM) before any B payment; buyer attempts/ still absent.
- 8.2 run5: purchase B PAID by ssf-buyer-sender (user-approved). Attempt 0db308d8…: created 13:09:12Z, target 4415228, expiry 4415248; tx-status (exit 0) state=mined at 4415230, txid ef13254fff8c…. status: ironwoodZat 9,780,000 = 9,890,000 − 100,000 − 10,000 fee. bytes-match and recover-without-repay PASS for A (sha cdf8ad2aad68 = fixture).
  restart-between FAIL 'already at 3 confirmations before the seller stop' at 13:10:00Z (49 s after send). Investigation: NOT a sender or matching bug. Testnet is currently producing blocks roughly every 8-10 s (tip 4414458 ~11:23Z -> 4414840 ~12:15Z -> 4415280 13:22Z), so B was mined 2 blocks after its target and had 3+ confirmations before the first receipt poll returned. The restart-between stage (stop the seller after the receipt is seen, before 3 confirmations) cannot be won reliably at this block rate.
  Orchestrator error: first tx-status probe used '--attempt' (invalid arguments, exit 2, nothing sent); rerun with '--attempt-id'.
- 2026-09-29 HANDOFF (machine change): all work committed and pushed to origin/feat/public-testnet (ledger force-added). Resume point: Wave 8.2.
  Open: restart-between FAIL is a timing problem (testnet ~8-10 s blocks; B mined 2 blocks after target), not a sender bug. Decide: loosen/rework restart-between for fast testnet, or record it as a deviation, then finalize T01, then 8.3 (archive zingo tooling/wallet, README 5.2g row).
  Also open: SSF_T01_CHROMIUM override in scripts/public-t01-live.ts has no test (system Chromium 153 crashes headless on download; use ~/.cache/ms-playwright chrome-headless-shell).
  NOT in git (copy securely): ~/.local/state/ssf-buyer (buyer seed + attempts), ~/.local/state/ssf-seller-wallet-vps (seller seed), .runtime/public/ (t01-run.json, buyer-sends.json, zingo wallet, fixtures, profiles, vps env copy), ~/.local/state/ssf-public/checker.
