# R — Final read-only review: Zakura buyer sender

Scope: tools/buyer-sender/src/{main,state,chain,pay}.rs, Cargo.toml; scripts/public-t01-wallet.ts, public-t01-live.ts (walletSend), public-t01.ts (WALLET_*); tests/unit/public-t01{-wallet,}.test.ts; README row 5.2g plus the CUA sentence; scanner private_fs.rs (the helpers it relies on). Nothing was built or run.

## Verified OK
- Output shapes and state/broadcast words match the frozen contract. `minedHeight` is null unless mined. Errors are `{"error":<&'static str>}`. The server's `error_message` is dropped.
- Persist-before-broadcast holds. `write_attempt` (create_new, 0600, fsync of the file) happens before `broadcast`. After pay.rs:313 the only exits are 0 and 3 (pay.rs:317-318).
- The exit-4 guard (pay.rs:197) runs under the flock, before the URI read and before `chain.connect`. The PanicChain test covers this.
- `expired` requires `Code::NotFound && tip > expiry` (chain.rs:204-210). Every other status and every timeout is `UNAVAILABLE` (chain.rs:211, 227), never `not_found`.
- The flock (LOCK_EX|NB) is taken in `dispatch_with` and held until the handler returns. Contention exits 2 with nothing done.
- Modes: the root, attempts/ and blocks/ are PrivateDir 0700. The seed (atomic), wallet.sqlite (checked before and after init), attempts and lock are 0600. The mnemonic and URI inputs must be 0600, owned by the user and not symlinks.
- No secret reaches stdout, argv or Debug output, except I-4 below. `Invoice` has a redacting Debug. `Globals`/`Command` Debug hold only paths and the attempt id.
- TS resolve table matches the brief:
  - mined → sent
  - expired → expired
  - not_found/forked → rebroadcast, stays pending
  - mempool, exit 3 or anything else → pending
  - no txid plus exit 2 `no attempt recorded` → removed; with a txid → kept
- tx-status connect/tip failures exit 2 (pay.rs:339-340). The TS side handles this safely: `code !== 0` and the error is not `no attempt recorded`, so the record stays pending.
- C2 digest: TS writes `uri` with no newline, both sides hash the exact bytes, and a test covers it.
- `rebroadcast` only resends `raw_hex`.

## Accepted departures (judged)
- Global flags after the command: harmless. Values are validated, and each flag is allowed only once.
- Fallback mkdir 0700 when the parent is 0755: acceptable. `PrivateDir::open` still checks the owner, the exact 0700 mode and O_NOFOLLOW on the final component.
- `CommandResult` carries the exit code in `Ok`: fine. It is used only for 0/3/4 with a recorded attempt.
- Prover warm-up via `bundle_version_for_branch`: fine. If it returns None, a later build failure is still exit 2 before the attempt file exists.
- Spawn failure (127) treated as nothing broadcast: fine. The binary never exits 127 itself, and a signal gives `code ?? 1`, which is treated as unknown.
- walletSend stops early on `expired` and returns ambiguous: safe and conservative. The runner marks it ambiguous and does not retry.

## Findings

- [Important] state.rs:227-260 (and state.rs:219-223 creating `attempts/`). The attempt file is fsynced, but the `attempts/` directory entry is not, and neither is the root after `attempts/` is created. A power loss after broadcast can lose the file. `resolvePending` would then see `no attempt recorded`, remove the txid-less pending record, and allow a second transaction for the invoice. Fix: after `create_new` + `sync_all`, `fsync` the attempts directory descriptor (and the root after first creating `attempts/`) before returning Ok.
- [Important] public-t01-wallet.ts:348 + tests/unit/public-t01-wallet.test.ts:222-238. The TS side allows re-paying an invoice whose record is `expired`, but the real binary keeps `attempts/<digest>.json` forever. Such a pay always exits 4, resolves to `expired` again and prints "UNRESOLVED … do not pay again" (exit 3). The test models behaviour the binary cannot produce. This is safe (no second transaction) but misleading. Fix: refuse `send` for a digest that already has an `expired` record ("invoice expired; request a new invoice"), and update the test to expect that refusal.
- [Important] pay.rs:180-184 / state.rs:264-285. The guard maps any `read_attempt` error to exit 2 even when an attempt file exists (unreadable, bad mode, invalid JSON). This breaks "exit 2 ⇒ no attempt file". TS then deletes the pending record (public-t01-wallet.ts:373-377) and says "nothing was broadcast", so the cap no longer counts a send that may be on chain. Fix: in `pay_guard`, when the entry exists but cannot be read or parsed, return exit 3 (outcome unknown) rather than 2.
- [Important] state.rs:45. `Attempt` derives `Debug` and so prints `raw_hex` (the raw transaction). This breaks the "no raw tx in Debug impls" rule, and a failing `assert_eq!` in tests already prints it. Fix: a manual `Debug` that redacts `raw_hex`.
- [Minor] pay.rs:339-340. tx-status connect/tip failures exit 2 although the attempt file exists (contract: 2 = no attempt file). TS is safe today, because only `no attempt recorded` removes a record. Fix: map these to `(3, error)`, as for `UNAVAILABLE`, so the exit codes stay consistent.
- [Minor] public-t01-wallet.ts:225. When the record has no txid, the TS adopts `json.txid` without checking `json.attemptId === record.invoiceDigest`. Fix: require that match before adopting the txid or expiryHeight, and before acting on `state`.
- [Minor] tests/unit/public-t01-wallet.test.ts:263-286. The exit-4 fixtures reply `{"error":"attempt already exists"}`, but the binary's exit 4 prints the attempt shape with `broadcast:"unknown"` (pay.rs:184). Fix: use `payOk(digest, 'unknown', 4)` so the txid/expiry recording path is exercised.
- [Minor] public-t01-wallet.ts:122. `defaultRunner` relies on `$HOME` for the state dir, and the "removed on `no attempt recorded`" rule assumes pay and tx-status see the same state dir. Fix: pass an explicit `--state-dir` (absolute `~/.local/state/ssf-buyer`, resolved once) on every call.
- [Minor] chain.rs:204-209. `expired` trusts a single lightwalletd's NOT_FOUND. A backend without a full tx index would report a mined tx as not found, and after expiry TS would allow a new payment. This meets the brief's rule, so it is defence in depth only. Fix: before reporting `expired`, check the wallet DB (after a sync) that the txid is not mined, or document the endpoint's txindex requirement.
- [Minor] public-t01-wallet.ts:106-110, 316-317, 367-397. The TS ledger has no inter-process lock. A manual `resolve` running while the runner's `send` runs can lose an update (the last writer wins). The sender's flock limits the damage, but add an `O_EXCL` lockfile around the ledger read-modify-write.
- [Minor] public-t01-wallet.ts:322-325. The manual CLI `send --uri <zip321>` puts the invoice URI on the node process's argv (it is pre-existing; walletSend calls in-process, so T01 is unaffected). Fix: accept `--uri-file` for manual use, or document that `send --uri` is for tests only.

## Verdict
**Needs fixes.** There is no Critical finding. Persist-before-broadcast, the exit-4 guard, the expired/transport rules, the flock and the TS resolve table are correct. Fix I-1 (fsync the attempts directory) and I-3 (guard read errors → exit 3) before the live Wave 8 payments, because both protect the "never a second transaction or silently uncounted send" invariant. I-2 and I-4 are small correctness and hygiene fixes. The Minor items can wait.
