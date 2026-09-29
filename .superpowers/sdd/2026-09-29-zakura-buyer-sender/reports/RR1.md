# RR1 — Scoped re-review of fix round 1 (read-only)

Inputs: R.md, fix1.json, `.runtime/public/diag/buyer-sender-fix1-review.diff`, plus the current `tools/buyer-sender/src/{state,pay,main}.rs`, `scripts/public-t01-wallet.ts`, `tests/unit/public-t01-wallet.test.ts` and the scanner `private_fs.rs`. Nothing was built or run.

## Per-finding verdicts

| ID | Verdict | Evidence |
|---|---|---|
| I-1 | **PARTIALLY ADDRESSED** | See below. The `attempts/` fsync after the file write is correct: state.rs:319-327, `sync_dir_of` at state.rs:82-87. The root fsync "when `attempts/` is newly created" (state.rs:277-290) never runs in the real `pay` flow. |
| I-2 | ADDRESSED | public-t01-wallet.ts:351-353: any existing record for the digest is refused, with an `expired`-specific message. This runs before the cap check and before any runner call. Tests: test.ts:222-240 (expired re-send refused, `later` is empty), 241-253 (`test.each` sent/expired), 255-265 (pending stays unresolved). |
| I-3 | ADDRESSED | state.rs:333-350: every failure after id validation maps to `Unreadable` (opening `attempts/`, proc_path, lstat other than ENOENT, read_file including mode/owner, JSON parse, id mismatch). pay.rs:178-183 maps `Unreadable` to `(3, …)` and `InvalidId` to 2. The mapping is used by `pay_guard` (pay.rs:196-203, before the URI read and `connect`) and by `recorded_attempt` (pay.rs:341-343) for tx-status/rebroadcast, which also runs before `connect`. Tests: main.rs `unreadable_attempt_exits_3_without_chain` (PanicChain calls == 0 for pay/tx-status/rebroadcast); state.rs `read_attempt_reports_unreadable_entries_distinctly`. |
| I-4 | ADDRESSED | state.rs:44-57: the manual `Debug` prints `raw_hex` as `"<redacted>"`, and derive(Debug) is removed. Test `attempt_debug_redacts_raw_hex` covers `{:?}` and `{:#?}`. `AttemptReadError` holds no data. |
| M1 | ADDRESSED | pay.rs:346-348 `unknown()`. In tx-status, parse, connect, tip and status failures are all exit 3 (pay.rs:358-364). In rebroadcast, hex decode, connect and tip failures are exit 3 (pay.rs:387-389). Test main.rs `chain_failures_with_recorded_attempt_exit_3`, which also shows that with no attempt the result stays 2 and nothing connects. TS test test.ts:321 confirms a record stays pending on 3. |
| M2 | ADDRESSED | public-t01-wallet.ts:222: the check `json.attemptId !== record.invoiceDigest` now gates adopting the txid/expiry (226-227) and the `state` switch. The pay-output path already required it (388-389). Tests test.ts:335 and :350. |
| M3 | ADDRESSED | test.ts:300 and :312 now use `payOk(digest,'unknown',4)`. The mempool case asserts that `txid` and `expiryHeight: 1021` are recorded. |

### I-1 detail: the root fsync never runs in the real pay flow
- `pay` calls `pay_guard` first (pay.rs:215). That calls `read_attempt`, which calls `self.attempts()` (state.rs:336). `attempts()` is `open_or_create_child`, which **creates** `attempts/` (private_fs.rs:77-87, `create_child` via `mkdirat`). The test helper confirms this: "A lookup creates the private `attempts/` directory" (main.rs ~612).
- So when `write_attempt` runs its `symlink_metadata` check (state.rs:281-285), `attempts/` always exists already. `attempts_created` is `false`, and the root directory is **never** fsynced after the `mkdirat`.
- This affects the very first pay on a fresh state root. That is exactly the first live Wave 8 payment.
- On ext4/xfs a directory fsync usually commits the journal, which in practice covers the earlier mkdir. That is not a POSIX guarantee, and it is the gap I-1 was raised to close.
- The new unit test (`write_attempt_creates_attempts_dir_and_syncs_without_error`) calls `write_attempt` directly on a fresh root, so it never takes the guard-first path and cannot catch this.
- **Fix (small):** fsync the root unconditionally in `write_attempt` before creating the file (`sync_dir_of(&attempts_entry)?` with no `attempts_created` condition), or fsync the root inside `attempts()` right after `create_child`. The failure mapping stays pre-broadcast exit 2.

## Checks the brief asked for

- **Is there any exit-2 path after the attempt file is written?** None was introduced.
  - In `pay`, after `write_attempt` returns Ok (pay.rs:331) the only results are 0 or 3 (pay.rs:335-336).
  - In `write_attempt`, every exit-2 error happens either before the file exists or after the file was removed.
  - tx-status: after `recorded_attempt` returns Some, every path is 0 or 3.
  - rebroadcast: the only remaining exit 2 after a read is `"attempt has expired; nothing was sent"` (pay.rs:390-392). This is pre-existing and is listed as deferred Minor D1.
- **fsync-failure path (state.rs:324-327):** safe. It runs inside `write_attempt`. `pay` propagates the Err with `refuse` (exit 2) at pay.rs:331, and `chain::broadcast` (pay.rs:335) is only reached on Ok. Nothing has been broadcast when the file is removed. TS then deletes the pending record ("nothing was broadcast"), which is correct.
  - Residual risk: the removal is not fsynced. After a crash the file could reappear. The next pay of that digest would then exit 4 with a never-broadcast txid, and resolve would rebroadcast those same bytes. That is still one transaction at most, so not a double-spend risk (D2).
- **Secret or raw tx reaching output:** none.
  - The new error strings are all `&'static str`.
  - `sync_dir_of` returns a fixed string.
  - `attempt_output` still omits `raw_hex` (pay.rs:563 test).
  - `Attempt` Debug now redacts `raw_hex`.
  - The TS changes only add comparisons and refusal messages; they print no URI or digest.
- **Refusing to pay because of the guard:** exit 3 for `Unreadable` is conservative. TS keeps the record pending, and tx-status also returns 3, so it stays pending and blocks further sends. There is no path where an unreadable attempt becomes "removed".

## New findings (fix diff)
- **[Important] I-1 residual:** the root fsync is dead code in the real pay path (above). There are no other Critical or Important issues.

## Deferred Minor (out of scope, or pre-existing)
- D1: pay.rs:390-392. rebroadcast with `tip > expiry` exits 2 even though the attempt file exists. This breaks "2 ⇒ no attempt file" for rebroadcast. It is harmless today because TS ignores rebroadcast results (wallet.ts:242), but for consistency it could be exit 3, or the contract could document that rebroadcast's exit 2 means "nothing sent now".
- D2: state.rs:316, 325. The cleanup `remove_file` on write/fsync failure is not followed by a directory fsync. A resurrected, never-broadcast attempt is still bounded to the same signed bytes.
- D3: state.rs:336. A failure to create or open `attempts/` (for example ENOSPC or EACCES on a fresh root) is now reported as `Unreadable`, exit 3, even when no attempt can exist. This is safe but leaves a txid-less pending record that only a manual fix can clear. The mapping could distinguish "directory absent and could not be created" (2) from "exists but unsafe" (3). Low priority.
- D4: The I-1 unit test cannot observe fsync and does not exercise the guard-first sequence. After the fix, a test that calls `pay_guard`/`read_attempt` before `write_attempt` on a fresh root would at least keep that ordering visible.
- The R.md Minors not in this round (`--state-dir` for `defaultRunner`, the single-lightwalletd NOT_FOUND trust, the TS ledger lock, `send --uri` argv) are still open as before.

## Verdict
**Needs one small fix (I-1 residual). Everything else is approved.**
- I-2, I-3, I-4, M1, M2 and M3 are ADDRESSED.
- No new Critical issue was found. Persist-before-broadcast, the rule that exit 2 means no attempt file (except the pre-existing rebroadcast/expired case, D1), and redaction of output and Debug all hold.
- Before live Wave 8 payments, fsync the state root unconditionally in `write_attempt` (or when `attempts()` creates the directory). As written, the root fsync never runs, because `pay_guard` always creates `attempts/` first.
