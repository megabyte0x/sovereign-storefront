# Zakura repository reuse analysis for the storefront MVP

Status: source-level analysis and design recommendations, not an approved implementation plan or production-readiness certification. No scanner was built, no new dependencies were installed, and no live payment was executed for this analysis.

## Recommendation

Build one production-directed, viewing-only Rust scanner beside the existing TypeScript storefront. Use `zakura-client-backend` and `zakura-client-sqlite` from `wallet-libraries`, with their compatible published `zakura-*` cryptographic dependencies from `common`. Run `zakurad` as a separate consensus node behind a compatible lightwalletd. Keep `ths` as a development environment only. Do not introduce a storefront dependency on its dashboard/activity API.

Do not combine all four repository heads into one Cargo workspace. `librustzcash` overlaps the other libraries and uses a different crypto package family. Use it as reference/test material rather than another wallet dependency.[5][8]

The existing application's Waku, Logos Storage, browser, and fulfillment gaps remain separate work. None of these repositories replaces those integrations.

## Scope and evidence

The four requested repositories were inspected at these exact commits:

| Repository | Inspected commit | Role |
| --- | --- | --- |
| `zakura-core/zakura` | `61e679ad4d188988d4683852b6031e0cffad9ebf` | Consensus node and chain RPC |
| `zakura-core/common` | `70c6c8e15736528f7b1dd8d5a9a1dbb7524a3d0c` | Keys, transaction primitives, shielded cryptography |
| `zakura-core/wallet-libraries` | `869a98221030e021d75384fc9b4ace18d1d52a86` | Wallet scanning, persistence, enhancement, rewind |
| `zakura-core/librustzcash` | `6487f1f10b55b74eedeb9eab4db4d7a24cfdbc9f` | Upstream-family reference, protocol utilities, tests |

Inspection covered repository manifests and README files, key API definitions, synchronization and received-output code, SQLite migrations, and relevant tests. Registry metadata was also checked. Source tests were read, not executed. Compatibility of a complete running stack remains unproven.

The storefront baseline previously exercised at `96700329ad782e49875b714d9536e97a7d93fdd8` was 113 unit tests, 28 browser tests, typecheck, and build passing. Those are deterministic application checks, not live scanner evidence.

## 1. zakura: reuse the node, not a wallet

Use the `zakurad` binary as the chain service. Its role is consensus validation, chain history, transaction retrieval/broadcast, and the RPC data that lightwalletd consumes. Do not link the full node into the seller process merely to verify invoices.[1]

This does not supply an invoice scanner. A raw shielded transaction contains encrypted payment data; transaction inclusion alone cannot prove which seller account received how much or what invoice memo was included. The separate wallet layer is required. The repository's zcashd-compatible mode is also not a reason to give the storefront a spending wallet.[1][7]

For the proposed scanner deployment, retain a source of historical raw transactions. Zakura's archive storage preserves historical RPC data; pruned mode deletes historical transaction bytes outside its retention window and cannot simply reopen as archive without resynchronization. An archive node is the simplest initial operational choice; a more elaborate historical data service can be evaluated later.[23]

Version choice matters. The inspected node head uses alpha common dependencies. The checked latest non-prerelease release was `v1.4.0`; treat it as a candidate qualification baseline, not as a demonstrated compatible production stack.[2][14]

## 2. common: reuse keys and primitives through one dependency family

Useful crates include:

- `zakura-keys` (Rust library name `zcash_keys`): UFVK decoding, network-aware key/address handling, and diversified shielded address derivation.
- `zakura-primitives` (`zcash_primitives`): transaction types and parsing when the scanner enhancement code needs them directly.
- Orchard, Sapling, Halo2, curve and proof implementations: generally transitive dependencies, not code to reimplement or manually assemble into the application.[3][4]

`UnifiedFullViewingKey::decode` checks the encoded network. However, decoding can retain disabled shielded components as unknown fields: the scanner must also require that the receiving pool's component is actually supported and available. Import success is not scanning capability.[21]

UFVK `address`, `find_address`, and `default_address` support address derivation without spending authority. Prefer the wallet-level persisted allocation APIs when issuing invoice addresses.[21][15]

`zcash_protocol`, `zcash_address`, and `zip321` are not renamed common workspace members. Follow the wallet workspace's compatible registry dependencies for them. The memo and network types belong to this protocol dependency family.[5][6][7]

Do not add `zakura-proofs` directly to the viewing-only scanner unless its own source actually uses a required prover API. Do not confuse that architectural choice with a claim of no proving-code linkage: the backend manifest already enables transaction `circuits` internally.[24]

## 3. wallet-libraries: the main reusable integration substrate

This repository is the most directly useful one. It exists to provide the wallet layer on the renamed Zakura crypto stack, avoiding accidental imports of a second upstream crypto family.[5]

### Reuse these interfaces

| Job | Existing surface | Application work still required |
| --- | --- | --- |
| Viewing-only account | `WalletWrite::import_account_ufvk`, `AccountPurpose::ViewOnly` | Safe credential provisioning, supported-pool validation, network and birthday configuration |
| Chain synchronization | `sync::run`, underlying `scan_cached_blocks`, generated lightwalletd client | Lifecycle, bounded block cache, retry/backoff, service health and endpoint qualification |
| Memo enhancement | `transaction_data_requests`, `decrypt_and_store_transaction`, `get_memo` | Retrieve and validate full transactions, process status requests, retry until relevant data is complete |
| Persistent wallet state | `zakura-client-sqlite` | Separate scanner database, migrations, backup/restore and receipt projection |
| Rewind/rescan | `truncate_to_height`, scan-range and chain-state interfaces | Revoke stale published evidence and rescan before reopening release eligibility |
| Address allocation | `get_next_available_address`, `get_address_for_index` | Durable, idempotent invoice mapping and receiver-level attribution |

These are real source interfaces, not a ready-made server or a verified end-to-end integration.[15][16][17]

### Critical caveats

1. **Sync is not memo completion.** `sync::run` explicitly does not download and enhance detected transactions. It also expects a `BlockCache` implementation. Its successful return cannot be translated directly into “all invoice memos verified.”[16]
2. **History is not the unspent balance.** A paid invoice must remain paid when the seller later spends the receipt. The `v_received_outputs` view contains actual received outputs across pools without an unspent filter; project those records with the transaction and account/address context.[18]
3. **Do not trust the name `get_received_outputs` alone.** It takes a known txid and computes confirmations-until-spendable. At this revision its SQLite query uses `v_tx_outputs` without a recipient-account predicate. This is not the storefront's ready-made incoming-receipt or confirmation API.[15][19]
4. **Reorgs do not delete all receipt rows.** The wallet deliberately retains received notes and memo information during rewind. Canonical status must come from updated mining/chain context, not row existence.[19]
5. **Health must describe the same evidence snapshot.** The storefront must not combine fresh scanner health with old unreconciled receipts. Publish a coherent generation containing source/network/account, scan frontier, tip identity, receipts and revocations.
6. **Pool identity belongs in output identity.** The schema distinguishes Orchard and Ironwood even at the same transaction/action index. Proposed external identity is network + txid + pool + output/action index, not an invented `:0`, wallet row ID, or commitment-tree position.[18]
7. **Protocol compatibility needs an actual probe.** With `orchard` enabled, this sync implementation requests both Orchard and Ironwood subtree roots. Do not assume the existing ths lightwalletd or an arbitrary public endpoint supports every call expected by this library version.[16]

Prefer an isolated, version-pinned received-history projection inside the scanner. If reading wallet SQLite views is necessary, keep schema coupling out of the TypeScript seller service, run reads in a coherent transaction, and add migration/shape regression tests. Do not write application data into wallet-owned tables.

## 4. librustzcash: reference and compatible utilities, not a second wallet stack

The fork includes upstream-named backend/SQLite, protocol, address, key, primitive, proof, ZIP-321, PCZT and pool-migration crates. Its manifest uses upstream crypto packages rather than the renamed Zakura family.[7][8]

Useful material:

- ZIP-321 `Payment::new` and `TransactionRequest` parsing/serialization, including tests for payment requests. Consume the compatible registry crate rather than copying the implementation.[22]
- Protocol/memo types and behavior, plus wallet/scanning/reorg test patterns.[7]
- Reference implementation details when checking behavior inherited by the selected wallet-libraries revision.

There is no basis here to call the whole fork obsolete. It is simply not the recommended additional dependency for a consumer already selecting the Zakura family.

Wallet-libraries is not a feature-identical copy: its README states that the pool-migration engine was removed while its schema migrations were retained. Ordinary database migration and migration of funds between shielded pools are different concerns.[5]

## Dependency/version recommendation

A candidate baseline to qualify, not a tested lockfile:

- Node: qualify stable `zakura v1.4.0`, with a compatible lightwalletd.[14]
- Scanner: `zakura-client-backend = 0.1.0-rc5` and `zakura-client-sqlite = 0.1.0-rc5`, or the inspected wallet Git revision; pin the eventual application lockfile.[9][10]
- Crypto: keep the compatible stable `zakura-* 1.2.0` family selected by the wallet workspace rather than substituting common HEAD. The checked keys, primitives, and Orchard registry packages expose that stable version.[11][12][13]
- Direct protocol dependencies: match the wallet's resolved versions; inspect package source IDs as well as names and versions.[6]
- Backend capabilities: `orchard`, `sync`, and the required lightwalletd transport/TLS features; SQLite `orchard`.[24][25] Avoid enabling all features without a reason.
- Toolchain: wallet manifests require Rust 1.91 and edition 2024; the node workspace has a separate higher toolchain requirement.[2][6]

The inspected common head is `1.3.0-alpha.1`, while the wallet workspace requests `1.2.0`. Those are not interchangeable source snapshots. Package aliases keep upstream Rust import names, so familiar `use zcash_*` paths do not prove compatible types. A direct git dependency can coexist with a registry dependency rather than replace it. Validate the final consumer graph.[4][5][6]

The node is a separate process and need not use the same Rust crate versions as the scanner; their protocol and RPC compatibility, however, must be tested. Published release-candidate wallet crates are not evidence of a reviewed production deployment.

## Design choice opened by this audit: invoice attribution

### A. Shared address plus mandatory memo

Keep the existing contract: each invoice gets a random `attributionRef`; a receipt must include that exact decrypted memo in the seller account. Missing or incorrect memo never matches.

Advantages: smallest change to the current invoice model.

Costs: requires a memo-capable payer and complete full-transaction enhancement before attribution. The current packaged ths faucet does not supply the needed memo path.

### B. Dedicated diversified shielded address per invoice

The library supports deriving and persisting addresses from an imported viewing key. Allocate a unique supported shielded receiver per invoice, persist the allocation idempotently, and match actual scanned received-note recipient information back to that allocation.[15][20][21]

Advantages: no dependency on the buyer preserving an invoice memo. For local tests, an arbitrary-address faucet can fund the scanner-owned invoice address; it does not need a new ths received-note API.

Costs and conditions:

- This changes the approved shared-destination/memo contract; obtain design approval first.
- Never reuse an expired invoice's receiver for a new invoice: late payment must remain attributable to the original terms.
- Persist account, derivation scope, diversifier index and exact supported receiver identity. Two different UA strings can share a receiver.
- SQLite can reconstruct an `ALLOW_ALL` UA for a received note; string equality with the originally displayed UA is therefore not a sufficient mapping rule.[20]
- Coordinate crash-safe scanner address allocation with storefront invoice creation using an idempotent allocation identifier; do not pretend two separate databases share an atomic transaction.
- Keep amount, timing, canonical-confirmation and duplicate-output checks.
- Still implement synchronization/reorg correctness. Unique addresses remove memo dependency for attribution, not the need for authentic received-note evidence.

Recommendation: evaluate B in the first bounded feasibility probe because it may eliminate both the ths memo limitation and a production wallet-UX dependency. Keep A available if preserving the existing contract is preferred. No attribution change has been approved or implemented by this report.

## Minimum application-owned work

The library stack avoids writing cryptography or a wallet database from scratch. It does not remove the need to build:

1. Scanner service startup/configuration, view-only wallet import and a bounded synchronization worker.
2. Required transaction enhancement/status processing.
3. Incoming-only receipt history projection with coherent generations, canonical evidence, replay and revocation.
4. A permission-restricted local scanner API and its TypeScript adapter.
5. Durable invoice attribution, using the approved memo or address strategy.
6. Payment reconciliation changes so first release is authorized against the latest reconciled generation.
7. Runtime composition, deployment configuration, observability and safe shutdown.
8. Live Waku browser/seller transport, hardened Logos replica retrieval and an honest integrated browser demo gate.

Keep spending keys out of the scanner. For regtest, a separate disposable payer/test harness can hold test spending authority; it must never become production fulfillment authority.

## First qualification gate for the implementation plan

Before committing to a same-day delivery estimate:

1. Resolve/build the minimal consumer dependency graph and verify one intended crypto family.
2. Against a demo-owned regtest environment, import a scanner-owned account's UFVK and correct birthday; do not retrieve ths seeds as a shortcut.
3. Prove the required compact-block, subtree-root, tree-state and transaction calls work with the selected lightwalletd/node versions.
4. Allocate two invoices at equal price, pay only one, and independently scan the exact received amount, pool/index and chosen attribution evidence.
5. Show zero release before the configured ten confirmations and one logical release after them.
6. Restart scanner/storefront and recover the receipt; exercise synthetic same-height fork/rewind/revocation tests separately from live-chain claims.

Passing this would qualify the payment vertical slice, not production readiness. Public testnet wallet interoperability and target-network upgrade/pool compatibility remain separate gates before mainnet.

## Decision needed before the implementation plan

Approve the production-directed scanner architecture, then select the attribution contract: retain mandatory memo matching, or prove and adopt dedicated per-invoice shielded receivers. Neither choice requires embedding ths in the production app or modifying the cryptography repositories.

## Sources

[1] https://github.com/zakura-core/zakura/blob/61e679ad4d188988d4683852b6031e0cffad9ebf/README.md
[2] https://github.com/zakura-core/zakura/blob/61e679ad4d188988d4683852b6031e0cffad9ebf/Cargo.toml
[3] https://github.com/zakura-core/common/blob/70c6c8e15736528f7b1dd8d5a9a1dbb7524a3d0c/README.md
[4] https://github.com/zakura-core/common/blob/70c6c8e15736528f7b1dd8d5a9a1dbb7524a3d0c/Cargo.toml
[5] https://github.com/zakura-core/wallet-libraries/blob/869a98221030e021d75384fc9b4ace18d1d52a86/README.md
[6] https://github.com/zakura-core/wallet-libraries/blob/869a98221030e021d75384fc9b4ace18d1d52a86/Cargo.toml
[7] https://github.com/zakura-core/librustzcash/blob/6487f1f10b55b74eedeb9eab4db4d7a24cfdbc9f/README.md
[8] https://github.com/zakura-core/librustzcash/blob/6487f1f10b55b74eedeb9eab4db4d7a24cfdbc9f/Cargo.toml
[9] https://crates.io/api/v1/crates/zakura-client-backend
[10] https://crates.io/api/v1/crates/zakura-client-sqlite
[11] https://crates.io/api/v1/crates/zakura-keys
[12] https://crates.io/api/v1/crates/zakura-primitives
[13] https://crates.io/api/v1/crates/zakura-orchard
[14] https://github.com/zakura-core/zakura/releases/tag/v1.4.0
[15] https://github.com/zakura-core/wallet-libraries/blob/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_backend/src/data_api.rs
[16] https://github.com/zakura-core/wallet-libraries/blob/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_backend/src/sync.rs
[17] https://github.com/zakura-core/wallet-libraries/blob/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_backend/src/data_api/wallet.rs
[18] https://github.com/zakura-core/wallet-libraries/blob/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_sqlite/src/wallet/init/migrations/ironwood_pool_code_views.rs
[19] https://github.com/zakura-core/wallet-libraries/blob/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_sqlite/src/wallet.rs
[20] https://github.com/zakura-core/wallet-libraries/blob/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_sqlite/src/wallet/orchard.rs
[21] https://github.com/zakura-core/common/blob/70c6c8e15736528f7b1dd8d5a9a1dbb7524a3d0c/crates/zcash_keys/src/keys.rs
[22] https://github.com/zakura-core/librustzcash/blob/6487f1f10b55b74eedeb9eab4db4d7a24cfdbc9f/components/zip321/src/lib.rs
[23] https://github.com/zakura-core/zakura/blob/61e679ad4d188988d4683852b6031e0cffad9ebf/crates/zakura-state/src/config.rs
[24] https://github.com/zakura-core/wallet-libraries/blob/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_backend/Cargo.toml
[25] https://github.com/zakura-core/wallet-libraries/blob/869a98221030e021d75384fc9b4ace18d1d52a86/librustzcash/zcash_client_sqlite/Cargo.toml
