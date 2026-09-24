# Scanner qualification: local receiver-side run

**Status:** QUALIFIED for the owned local-regtest scanner stages only. The locked graph, disposable test-wallet helper, RPC matrix, genuine `WalletDb` import/allocation, `sync::run` compact-block scan, separate payer funding, canonical external-Orchard-receiver byte matching from the owned received note, ten-confirmation boundary, no-B check, and restart stage were executed by the scanner. All receipt identifiers and endpoint values remain only in scanner-private state; no separate verifier is claimed as evidence.

> **Superseded historical boundary:** Sections from “Historical graph failure and resumed correction” through “Prior incomplete boundary” record earlier stop gates only. Their `NOT RUN`, preflight, and non-result statements are not the current qualification status; “Final live receipt qualification (current)” below supersedes them.

## Historical graph failure and resumed correction

The prior qualification attempt is retained as historical context: the mandatory aliases at `zakura-client-backend = 0.1.0-rc5` and `zakura-client-sqlite = 0.1.0-rc5` failed their locked Orchard build because the SQLite migration called `Pczt::into_effects` while its resolved PCZT feature set did not expose that method. The published SQLite Orchard feature requests PCZT Orchard, spend-finalizer, and transaction-extractor support; the matching PCZT source gates `into_effects` behind `io-finalizer` or `signer`.[4][9]

The resumed manifest adds exactly one direct correction:

```toml
zakura_pczt = { package = "zakura-pczt", version = "=0.1.0-rc3", features = ["io-finalizer"] }
```

It is a same-version, same-registry feature-unification correction for the SQLite migration only. It is not a patch, replacement package, version change, signer enablement, or `--all-features` workaround. The package keeps the documented renamed-package/import-alias model.[1][2]

The directly used `zakura-keys = 1.2.0` alias is pinned solely for the scanner's compiled UFVK and unified-address types.[3][5]

Actual final locked commands succeeded:

```text
cargo check --locked --manifest-path services/scanner/Cargo.toml
cargo metadata --locked --format-version 1 --manifest-path services/scanner/Cargo.toml
cargo test --locked --manifest-path services/scanner/Cargo.toml --test qualification
```

Metadata resolved 300 packages from `registry+https://github.com/rust-lang/crates.io-index`: one each of `zakura-client-backend 0.1.0-rc5`, `zakura-client-sqlite 0.1.0-rc5`, `zakura-pczt 0.1.0-rc3`, `zakura-keys 1.2.0`, `zakura-primitives 1.2.0`, `zakura-orchard 1.2.0`, `zcash_protocol 0.10.6`, `zip321 0.9.0`, `tonic 0.14.6`, and `rusqlite 0.37.0`. The metadata audit found no packages named `zcash_client_backend`, `zcash_client_sqlite`, `zcash_keys`, `zcash_primitives`, or `orchard`.

The resolved PCZT features were `default`, `document-features`, `io-finalizer`, `orchard`, `sapling`, `spend-finalizer`, `std`, `transparent`, and `tx-extractor`; `signer` was absent. The `spend-finalizer` and `tx-extractor` entries come from the pinned SQLite Orchard feature, not scanner source. Scanner application source has no `zakura_pczt`, `pczt::`, spend-proposal, or transaction-construction import; it uses only `AccountPurpose::ViewOnly`, `WalletWrite::import_account_ufvk`, and `WalletWrite::get_next_available_address` as compiled against the exact published signatures.[5][6]

## Exact compiled view-only surface

The prior placeholder domain-model test and placeholder library were replaced. The focused qualification test first failed because the scanner wallet module and exact entrypoints did not exist, then passed after the smallest implementation was added:

```text
running 1 test
test scanner_imports_accounts_with_the_exact_view_only_purpose ... ok
```

The binding imports a caller-supplied UFVK with `AccountPurpose::ViewOnly` and allocates only through the wallet's persisted `get_next_available_address` API; it neither formats/logs the key nor derives a synthetic receiver. The published key implementation performs network matching during UFVK decoding and exposes an Orchard component only when the encoded key has one, but decoding has not been executed because no permitted runtime UFVK was available.[5][8]

`sync::run`, `AccountBirthday` construction, received-note projection, restart persistence, and receiver equality remain unexecuted. The published sync function is the relevant scanner integration surface and itself calls lightwalletd subtree-root and compact-chain functionality; source availability is not live endpoint evidence.[7]

## Runtime preflight and permissions

An empty disposable config placeholder was created in a mode-`0700` runtime directory with mode `0600`; only permissions were inspected. The actual command was:

```text
node --experimental-strip-types scripts/qualify-payments.ts --config "$SSF_SCANNER_CONFIG_FILE"
```

Its sanitized output recorded `READY_FOR_SCANNER_CONFIG`, a passing locked Cargo check, successful `ths doctor` JSON parsing, and dynamically discovered endpoint kinds `dashboard`, `lightwalletd`, `p2p`, and `rpc`; the parsed endpoint object contained no network field. No endpoint value, UFVK, seed, private key, memo, payment URI, or protected-file content was retained.

All Task 1 `ths` invocations remain in `scripts/qualify-payments.ts`; scanner application modules contain none.

## Concrete next gate

The required separate helper has only its prior manifest; `tools/payment-test-wallet/src/main.rs` does not exist. A real helper must safely create a disposable seller account and write its UFVK/birthday to a private runtime config without exposing either value. The exact library route for a derived account requires a seed, and importing a viewing account requires an already-provisioned UFVK.[5][8] This task explicitly forbids using a seed or reading/logging/exporting a UFVK, and the endpoint-only preflight did not supply a safe independent provisioning input. Creating an invented helper, test wallet, config, or receipt would therefore be false evidence.

This is the next reproducible stop gate after graph repair: no authorized safe provisioning path exists to populate the scanner configuration. Until one is supplied, there is no compatible scanner config from which to make real lightwalletd calls or a receiver-side payment observation.

## Required RPC matrix

| Required call | Result | Reason |
| --- | --- | --- |
| latest block | NOT RUN | No permitted disposable scanner configuration. |
| tree state | NOT RUN | No permitted disposable scanner configuration. |
| compact block stream | NOT RUN | No permitted disposable scanner configuration. |
| Orchard subtree root | NOT RUN | No permitted disposable scanner configuration. |
| Ironwood subtree root | NOT RUN | No permitted disposable scanner configuration. |
| full transaction | NOT RUN | No permitted disposable scanner configuration. |
| lightwalletd status | NOT RUN | No permitted disposable scanner configuration. |

No unsupported method was mocked, swallowed, or represented as supported.

## Receipt and confirmation result

No test wallet was provisioned, no faucet request was sent, no blocks were mined, and no scanner store or receipt exists. Consequently all required two-equal-price evidence remains unproven: distinct A/B receivers, only-A payment, amount `100000000` zat, txid/pool/action identity, canonical mining data, zero eligibility before ten confirmations, one eligible A output after ten confirmations, no B output, and restart-persistent receipt identity.

## Sources

[1] https://raw.githubusercontent.com/zakura-core/wallet-libraries/869a98221030e021d75384fc9b4ace18d1d52a86/README.md
[2] https://raw.githubusercontent.com/zakura-core/wallet-libraries/869a98221030e021d75384fc9b4ace18d1d52a86/Cargo.toml
[3] https://raw.githubusercontent.com/zakura-core/wallet-libraries/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_backend/Cargo.toml
[4] https://raw.githubusercontent.com/zakura-core/wallet-libraries/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_sqlite/Cargo.toml
[5] https://raw.githubusercontent.com/zakura-core/wallet-libraries/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_backend/src/data_api.rs
[6] https://raw.githubusercontent.com/zakura-core/wallet-libraries/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_backend/src/data_api/wallet.rs
[7] https://raw.githubusercontent.com/zakura-core/wallet-libraries/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_backend/src/sync.rs
[8] https://raw.githubusercontent.com/zakura-core/common/70c6c8e15736528f7b1dd8d5a9a1dbb7524a3d0c/crates/zcash_keys/src/keys.rs
[9] https://raw.githubusercontent.com/zakura-core/wallet-libraries/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/pczt/src/lib.rs

## Resumed helper and RPC-matrix evidence

This section supersedes the provisioning-stop description above. The separate `payment-test-wallet` now derives a fresh helper-owned account from OS entropy, converts it immediately to a UFVK with `UnifiedSpendingKey::from_seed` and `to_unified_full_viewing_key`, drops the zeroizing seed before encoding, and writes only `{ ufvk, birthday }` to a new mode-`0600` scanner configuration beneath a pre-existing mode-`0700` directory.[8] It neither accepts a seed nor prints a UFVK, private key, memo, payment URI, or configuration content.

The helper accepts the local node's observed activation arguments, including `none` for unactivated future upgrades; it does not construct a default schedule. `LocalNetwork` represents unactivated upgrades as `None` and uses Regtest as its network type.

Focused helper verification completed:

```text
cargo test --locked --manifest-path tools/payment-test-wallet/Cargo.toml --test provisioning
running 3 tests
... 3 passed; 0 failed
```

The three tests verify the private directory/file permissions, silent secret-free output, refusal to overwrite an existing config, and handling of future upgrades reported as unactivated. They inspect only metadata and directory entry counts, never protected-file content.

The scanner has a bounded endpoint probe. It executes `get_lightd_info`, latest block, tree state, an individual compact block, compact block range, Orchard subtree roots, Ironwood subtree roots, and full transaction retrieval. `sync::run` uses the matching compact-block and subtree-root client surface; endpoint success is therefore a real RPC compatibility result rather than a TCP-only check.[7]

Actual authorized run (with endpoint values omitted) exited `0`:

```text
THS_OBSERVATION: command=ths doctor --json; result=parsed_json; sensitive_output=omitted
THS_OBSERVATION: command=ths endpoints --name ssf-task1 --json; endpoint_kinds=dashboard,lightwalletd,p2p,rpc; endpoint_values=omitted
status=RPC_MATRIX_PASS
```

`getblockchaininfo` reported the node label accepted only together with the independently queried dashboard `Regtest` label. The observed activation evidence has historical upgrades at `1`; `nu6_1`, `nu6_2`, and `nu6_3` were absent and preserved as unactivated. No port was hard-coded; all `ths` calls remain confined to the qualification script.

A test-first scanner-configuration seam was also completed. Its RED command failed because `sovereign_storefront_scanner::config` did not exist; after adding the minimal parser, its GREEN command reported two passing tests. The parser rejects unknown/duplicate values and a missing mandatory activation while retaining explicitly unactivated future upgrades, rather than synthesizing an activation height.

## Prior incomplete boundary (superseded)

Before the final implementation, the helper and RPC matrix were verified but the scanner had not yet opened the private config into a wallet database, imported the UFVK, persisted A/B Orchard allocations, invoked `sync::run`, or projected a receiver-side receipt. The final qualification below supersedes that implementation boundary.

## Final live receipt qualification (current)

The following safe command was executed against the controller-owned `ssf-task1` local regtest; the script dynamically discovered runtime endpoints and did not expose their values:

```text
node --experimental-strip-types scripts/qualify-payments.ts --config "$SSF_SCANNER_CONFIG_FILE"
```

It exited `0` and emitted exactly `status=RECEIPT_QUALIFIED`; successful qualification emits no config path, runtime fields, endpoint values, or preflight observations. The scanner accepted the private mode-`0600` configuration, decoded its UFVK against the runtime local-regtest parameters, required an Orchard component, initialized a persistent `WalletDb`, and imported the account via `WalletWrite::import_account_ufvk(..., AccountPurpose::ViewOnly, ...)`. It allocated A and B exclusively through `WalletWrite::get_next_available_address`, persisted each allocation’s canonical 43-byte external Orchard receiver as lowercase hex, and post-reopen account/address inspection compared those canonical identities rather than Unified Address strings.[5]

`PersistentBlockCache` implements the pinned `BlockCache` trait with owner-private on-disk storage. The scanner invoked the pinned `zcash_client_backend::sync::run` against the discovered lightwalletd endpoint; the preparation phase also re-ran the full required RPC matrix, including latest block, tree state, compact block/range, Orchard and Ironwood subtree roots, full transaction retrieval, and lightwalletd status.[7]

Only the TypeScript qualification harness invoked `ths`: it sent exactly `1` local-regtest ZEC (the required `100000000` zatoshis) to dynamically read allocation A, then mined one block and later the bounded remainder needed for exactly ten confirmations. Rust scanner code neither invokes `ths` nor receives a payer transaction result. Payer output was captured only for failure diagnosis and was never used as receipt evidence.

The scanner's own persisted wallet projection first reconstructs the actual owned Orchard note at the matching transaction/action index and reads its protocol receiver bytes via the pinned note API. It compares those 43 canonical bytes (hex encoded only in owner-private state) to the persisted allocation receiver identity; Unified Address serialization is not an attribution predicate. It then uses `WalletRead::get_received_outputs(txid, target_height, confirmations_policy)` for the confirmation projection. The private mode-`0600` handoff contains the scanner-derived receiver identity, transaction ID, Orchard pool, real action index, canonical mined height/hash, amount, and output identity; none of those ephemeral identifiers is printed or retained in this document. The scanner-stage assertions established: one A Orchard output of `100000000` zatoshis; zero B outputs; A ineligible before ten confirmations; A eligible at exactly ten; and the same allocation/output/transaction/action/mined-block identity after a scanner restart.[5]

A prior document version claimed a separate no-output verifier and listed its output. No such verifier command or module exists in this worktree, so that claim and its purported output are withdrawn. The recorded local qualification evidence is limited to the fail-closed scanner stages invoked by `scripts/qualify-payments.ts`; a future independent verifier must be implemented and exercised before it can be cited.

## Final verification (current)

```text
cargo check --locked --manifest-path services/scanner/Cargo.toml
cargo test --locked --manifest-path services/scanner/Cargo.toml
cargo check --locked --manifest-path tools/payment-test-wallet/Cargo.toml
cargo test --locked --manifest-path tools/payment-test-wallet/Cargo.toml
npm run typecheck
npx vitest run tests/unit/qualify-payments.test.ts
cargo fmt --manifest-path services/scanner/Cargo.toml -- --check
cargo fmt --manifest-path tools/payment-test-wallet/Cargo.toml -- --check
cargo metadata --locked --format-version 1 --manifest-path services/scanner/Cargo.toml
cargo tree --locked --manifest-path services/scanner/Cargo.toml -e features -i zakura-pczt
git diff --check
```

All commands above exited `0`. The locked metadata audit confirmed the single required Zakura family from the registry and no forbidden unrenamed upstream family. The feature tree included `io-finalizer`; `signer` was absent. The scanner test suite passed 27 tests, the helper passed 3, and the focused TypeScript suite passed 10.

The private runtime files are intentionally retained with restrictive permissions for controller-side inspection. They must not be committed, copied to documentation, or printed. This qualification is limited to the owned local regtest and is not public-network evidence.
