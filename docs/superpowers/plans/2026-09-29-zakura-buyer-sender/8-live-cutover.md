# Wave 8: live verification and cut-over  (parent Task 7)

Orchestrator-run with the user; not a delegated worker (live funds, secret files, T01 runner state).

Precondition gate (all must hold; else stop and ask the user): R review clean; purchase A `sent` in `buyer-sends.json`; T01 runner exited; `ps -eo pid,args | grep zingo-cli | grep -v grep` empty.

## 8.1 Import and parity  (parent 7.1–7.5)
- Inspect `.runtime/public/buyer-wallet/recovery-info.private` structurally only (line/word counts). Extract phrase + birthday into a 0600 file under `~/.local/state/`; `shred -u` it after import.
- `ssf-buyer-sender import --mnemonic-file <f> --birthday <h>`; ledger `{birthday, tip}` and wall time.
- UFVK parity: zingo `export_ufvk` (clearnet, `--nosync`) piped straight into `sha256sum`, vs a scratch `tools/buyer-sender/examples/ufvk_digest.rs` printing only the digest of the UFVK derived from `seed.private`; delete the example afterwards. Ledger only "digests equal".
- `status`: expect 10,000,000 minus purchase A amount and fee in `ironwoodZat`; ledger numbers and wall time.

## 8.2 Purchase B  (parent 7.6)
- T01 runner `run` for purchase B as normal. Record the `pay` build wall time (ARM proving), `accepted`, scanner + checker receipts, finalize.

## 8.3 Retire zingo and record  (parent 7.7–7.8)
- Move `.runtime/public/tooling/zingolib-v6*` and `.runtime/public/buyer-wallet/` into 0700 `.runtime/public/archive/zingo-<date>/`; remove `SSF_BUYER_TRANSPORT` from local env files.
- Public-testnet README row 5.2g → done with evidence from 8.1–8.2.
- Record, don't do: zingolib `DESTINATION_INDEXERS` testnet issue draft (to the user first, no local paths); rc7 move + `zakura-transaction-status`; optional regtest round trip; carried Minors from R.
- Commit only if the user asks (Conventional Commits).
