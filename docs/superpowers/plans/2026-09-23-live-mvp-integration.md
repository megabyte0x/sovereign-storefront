# Live MVP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing storefront through real Waku checkout, receiver-verified shielded payment, durable fulfillment, independent Logos replica retrieval and browser decryption, without a production dependency on ths.

**Architecture:** A viewing-only Rust service uses the repository-recommended Zakura wallet packages against node/lightwalletd and allocates a unique Orchard receiver per invoice. The TypeScript seller consumes coherent receipt snapshots over a private Unix socket, applies settlement/release policy, and exchanges authenticated encrypted Waku messages with the browser. Logos origin/replica publication is separate from replica-only download.

**Tech Stack:** Existing Node >=22, TypeScript, Vite, Vitest, Playwright and SQLite; Rust wallet-libraries consumer, tonic/lightwalletd, Unix HTTP socket; Gate A Waku SDK/encryption; existing logosctl/storage_module adapter. Actual supported Node/Rust versions and all dependency resolutions are recorded by Task 1.

**Spec:** `docs/superpowers/specs/2026-09-23-live-mvp-integration-design.md`, supplementing `docs/mvp-design.md`; repository/API evidence in `docs/zakura-reuse-analysis.md`.

## Global constraints

- This document is the planning deliverable. Do not execute it until the user requests implementation. Do not commit, push, open a PR, or modify ths/upstream repositories without separate authorization.
- Preserve pre-existing untracked `AGENTS.md` and `brief/`. Baseline inspected: `96700329ad782e49875b714d9536e97a7d93fdd8` on `main`; recheck before execution. New planning documents are uncommitted and must be copied into an execution worktree if one is used.
- Local target L: actual Waku + two local Logos nodes + independently scanned Zakura/regtest payment. Public-testnet target T is separate. Mainnet remains forbidden.
- Ten confirmations; health age at most 120,000 ms; future scanner timestamps rejected; integer-zatoshi strings only.
- Unique external Orchard receiver per NEW live invoice; no transparent fallback, mandatory invoice memo, amount-only match, shared-address guess, or payer-supplied receipt.
- First-release maximum: 41-byte plaintext / 73-byte ciphertext. This is not useful-size product-file qualification or public Logos deployment.
- Seed/spending keys remain outside scanner/seller. UFVK and application secrets stay in private runtime files, never logs, browser, report, command arguments, or git.
- Keep deterministic tests, but never use their adapters in a live run or call an unexecuted/unsupported gate PASS.
- Every code task follows RED → GREEN → focused regression → self-review. Code snippets below define new application surfaces or test assertions, not claims that those symbols already exist upstream. Obtain exact wallet API argument types from the pinned sources in Task 1; no fabricated APIs.
- Per-instance test hooks only. No process-global mutable production test switches or payment override endpoints.
- Wallet SQL boundary: read-only, exact-version-coupled projection of wallet-owned SQLite views and the necessary documented table joins is permitted ONLY inside Rust `services/scanner/src/projection.rs`. Open the projection connection read-only; perform wallet imports, derivation, scanning, enhancement, migrations and rewinds through the pinned wallet library. Never write application data into wallet-owned tables, query wallet SQL from TypeScript, or expose database rows/UFVK through the socket. Scanner-owned allocation/history/snapshot persistence uses a separate application database. Isolated test-fixture construction is not permission to mutate runtime wallet tables.
- Keep `zakura-client-backend` and `zakura-client-sqlite` at `=0.1.0-rc5` for the resumed projection work. Absence of a production history convenience API is not by itself a blocker: this plan deliberately uses a pinned Rust SQL projection. Do not enable `WalletTest`/`test-dependencies` in production, substitute unspent notes for history, or change the dependency family to evade the boundary. A pin change requires a concrete failure of the permitted projection path and renewed qualification, not only `get_tx_history` failing to compile.

## 1. Current implementation map

| Existing source | Change required | Owner |
| --- | --- | --- |
| `src/main.ts:1-8` | Construct/inject actual adapters and own shutdown | Task 10 |
| `src/config.ts:16-37,95-159` | Remove test/regtest split; explicit live runtime config | Tasks 2, 10 |
| `src/contracts/types.ts:13-30,83-106,117-142` | Snapshot, allocation, wire and store contracts | Task 2 |
| `src/seller/schema.sql`, `db.ts`, `invoices.ts` | Versioned migration, immutable draft/allocation, full reconciliation | Tasks 2, 4, 5 |
| `src/seller/payments.ts:28-36,54-63,152-156,341-380` | Remove height ordering and stale-health release; explicit disclosure boundary | Task 5 |
| `src/adapters/scanner.ts` | Keep clearly labelled fixture; no dashboard mapping used live | Tasks 2, 3 |
| `src/adapters/messaging.ts`, `credentials.ts` | Separate fixture introspection from real transport; signed ECIES | Tasks 2, 6 |
| `src/seller/server.ts:220-275,383-456` | Shared business handlers; live Waku readiness; disable HTTP purchase routes | Tasks 7, 10 |
| `src/adapters/storage.ts:73-84,178-215,229-319` | Explicit paths, asynchronous CLI, exact completion, origin-independent reads | Task 8 |
| `src/browser/app.ts:179-251` | Remove live HTTP flow/private export; genuine QR | Task 9 |
| `src/seller/backup.ts`, `scripts/backup-check.ts` | Encrypted coordinated seller/scanner restore | Task 11 |
| `scripts/demo-check.ts`, `docs/demo-results.md` | Strict built-app run, source-linked evidence | Task 12 |

The current height guards in `db.ts:90-92,163-170` can discard valid lower-height reorg corrections. Current `healthAllowsRelease` does not require the receipt and health to refer to the same chain hash/generation and accepts future check times. Treat these as required correctness fixes, not optional cleanup.

Existing test/build evidence from the investigation: 113 unit tests, 28 browser tests, typecheck and build passed. That is not live-integration evidence. Re-run the baseline during execution.

## 2. Execution order and ownership

One integration release, three workstreams, one shared contract boundary:

    Task 0: safe workspace, clean build
       ↓
    Task 1: real payment/scanner feasibility gate — STOP if it fails
       ↓
    Task 2: shared contracts, migrations, fixture compatibility
       ├── Payment: Task 3 → Task 4 → Task 5
       ├── Waku:    Task 6 → Task 7
       └── Storage: Task 8
                  Task 9 after Task 6 (browser uses frozen contracts)
       ↓ all tracks
    Task 10: built runtime composition
       ↓
    Task 11: coordinated backup/restore
       ↓
    Task 12: strict live L demo; separate public-testnet T qualification

Task 2 is SERIAL and produces all shared interfaces, schema primitives, decoder validators and deterministic fixtures. Later workers do not independently edit `types.ts`, `live.ts`, `schema.sql`, migrations or root dependencies. Missing contract changes return to the integrator before parallel work resumes. Tasks 4/5 may sequentially extend implementations of the frozen store operations; Task 7 consumes interfaces, not a second private order store.

Task 2 owns package/lockfile additions for Waku and a QR encoder/decoder after checking availability. Task 3 owns only `services/scanner/` and `src/adapters/wallet-scanner.ts`; Task 6 owns Waku/credential implementation; Task 7 owns seller message handlers and live HTTP restriction; Task 8 owns storage/gateway/catalogue behavior; Task 9 owns browser files. Task 10 owns final `main.ts`, configuration/startup wiring and shared script integration. Any overlaps are serialized explicitly.

Task 3 also owns its named adapter tests and `docs/scanner-projection-compatibility.md` evidence document. Its Rust SQL permission must travel verbatim in every task brief/reviewer handoff; do not shorten it to “no wallet SQL.” Tasks 6 and 8 are independent of Task 3 after Task 2; they may proceed within their ownership boundaries, but cannot establish live-payment or overall L completion. Tasks 4/5 and integrated release remain gated on Task 3.

For the same-day objective, timebox Task 1 to a first decision checkpoint of 60–90 minutes, not a promise that a Rust build or protocol qualification fits it. If receiver evidence is still unproven, report that blocker and revised scope immediately. Do not spend the rest of the day polishing a fake payment path. L is the first release target; T does not block documenting an honestly labelled L result, but it blocks public-testnet claims.

## 3. Shared application contracts — Task 2 owns the interfaces

Task 2 owns the shared contracts below; Section 3.1a specifies Task 3's internal implementation of the frozen snapshot interface, not a new Task 2 deliverable.

### 3.1 Snapshot and allocation

Create `src/contracts/live.ts` and mirror its version-1 JSON schema in `services/scanner/protocol/schema.json`. JSON integers that may exceed JavaScript precision use decimal strings. These are application types, not copied wallet-library types.

```ts
export type Network = 'test' | 'regtest';
export type ChainIdentity = {
  network: Network;
  genesisHash: string;          // block-0 hash, RPC display order (`getblockhash 0`)
  consensusFingerprint: string; // v1 SHA-256 of the canonical activation schedule, Section 3.1b
};
export type ReceiverRef = {
  accountId: string;
  scope: 'external';
  pool: 'orchard';
  diversifierIndex: string; // exact 11-byte index encoding, not a JS number
  receiverHex: string;     // library-serialized Orchard address bytes
};
export type AllocateReceiver = {
  allocationId: string; chain: ChainIdentity; accountId: string;
  amountZat: string; expiresAt: number;
};
export type ReceiverAllocation = AllocateReceiver & {
  destination: string; receiver: ReceiverRef; paymentUri: string;
};
export type Receipt = {
  outputId: string; txid: string; pool: string; outputIndex: number;
  accountId: string; scope: 'external' | 'internal'; receiverHex: string;
  amountZat: string; firstSeenAt: number;
  mined: { height: number; hash: string } | null;
  canonical: boolean;
};
export type ScanSnapshot = {
  version: 1; sourceId: string; generation: string;
  chain: ChainIdentity; accountId: string;
  tip: { height: number; hash: string };
  scanned: { height: number; hash: string };
  checkedAt: number; caughtUp: boolean; complete: boolean;
  health: 'ready' | 'syncing' | 'unavailable';
  receipts: Receipt[];
};
export interface ReceiptSource {
  snapshot(): Promise<ScanSnapshot>;
  allocateReceiver(input: AllocateReceiver): Promise<ReceiverAllocation>;
  close(): Promise<void>;
}
```

`health='ready'`, `complete=true`, caught-up/equal tip and scanned hashes are all required for first release. Allocation validates chain/account even when retrying. Limit snapshots to 10,000 receipts / 16 MiB. No pagination or incremental height cursor in v1; an oversized snapshot is unavailable. Normalize receipt amounts and identity once in Rust and validate again at the private API boundary.

Replace the authoritative seller `Scanner` contract with `ReceiptSource`. Legacy `health()/observations()` can survive inside explicitly labelled fixture utilities only; real settlement must consume one `snapshot()`. `MemoryScanner` must supply the new surface and permit deterministic lower-height/same-height snapshot replacement.

### 3.1a Rust history projection boundary — Task 3

No public wire-contract change is needed. Task 3's internal `read_wallet_history` operation reads the selected account's received Orchard history, then the scanner-owned history journal supplies persisted `firstSeenAt` and revocation history before publication through the existing `Receipt[]`/`ScanSnapshot` contract. Raw query rows are never treated as complete snapshots or sent to TypeScript. Unknown schema, malformed ownership/receiver data, missing required enhancement, or an incoherent chain read makes the snapshot non-ready/incomplete; do not drop an unresolved candidate and label the remainder complete.

Pinned source evidence, relative to the Cargo-resolved `zakura-client-sqlite-0.1.0-rc5` package:

- `src/wallet/db.rs:1282-1346`: `v_received_outputs` enumerates received outputs without an unspent filter; Orchard pool is `3` and its real action index is `output_index`.
- `src/wallet/db.rs:289-297,459-485,1609-1687`: transaction `block` is scanned-block linkage; `mined_height` alone is not. `v_tx_outputs` also includes outgoing rows and derives scope from an address join; it is not an unfiltered incoming-receipt API. The received-note table retains decryption scope; internal notes may have no address row.
- `src/wallet.rs:4222-4229,4393-4404`: rewind clears mining associations and deletes removed blocks while retaining received notes. Row existence does not prove canonicality.
- `CHANGELOG.md:941-943`: external consumers are advised to ignore the internal received-output `address_id`. This plan deliberately permits narrowly isolated, tested schema coupling where necessary; it does NOT claim those joins are a stable supported public API. Use the actual final view columns, not prose alone (`v_tx_outputs` does not expose `diversifier_index_be`).

The backend's `src/data_api.rs:2571-2600` confirms that `get_received_outputs` requires a known txid and `get_tx_history` belongs to test-only `WalletTest`. Neither limitation forbids the projection above. Task 1's current `scan.rs::raw_receipts` plus `get_unspent_orchard_notes_at_historical_height` is limited qualification code, not full-history production evidence; Task 3 replaces that production dependency and consolidates wallet SQL into `projection.rs`.

Use this pinned read-query shape as the executable compatibility starting point, with `?1` bound to the internal account ID obtained from the imported account, never a caller-supplied SQL fragment:

```sql
SELECT t.txid, ro.pool, ro.output_index, ro.value,
       a.uuid AS account_uuid,
       n.recipient_key_scope AS note_scope,
       ad.key_scope AS address_scope, ad.address AS received_address,
       t.block AS scanned_block_height, t.mined_height,
       b.hash AS scanned_block_hash
FROM v_received_outputs AS ro
JOIN transactions AS t ON t.id_tx = ro.transaction_id
JOIN accounts AS a ON a.id = ro.account_id
LEFT JOIN orchard_received_notes AS n
  ON n.id = ro.id_within_pool_table
 AND n.transaction_id = ro.transaction_id
 AND n.action_index = ro.output_index AND n.account_id = ro.account_id
LEFT JOIN addresses AS ad ON ad.id = ro.address_id
LEFT JOIN blocks AS b ON b.height = t.block
WHERE ro.account_id = ?1 AND ro.pool = 3
ORDER BY t.txid, ro.output_index
```

Read all candidates before classification: exclude known internal scope (`1`); require external note/address scope (`0`) for an external receipt; unknown/missing/conflicting scope or a missing/malformed external address fails completeness. Decode `received_address` with the pinned network-aware library, extract the Orchard receiver bytes and compare them, never UA spelling. This query intentionally uses the received address, not `v_tx_outputs`' preference for a sent-to address. Validate relationship integrity and account binding rather than letting broken joins silently shrink history. Use library txid formatting and the actual pool/index; neither commitment position nor a fabricated zero is an output index. Unsupported pools remain ineligible.

Keep spent rows and rows with null mining linkage. Canonical mined evidence requires matching `block`, `mined_height`, and scanned block hash under the coherent reconciled chain; a height obtained only by transaction retrieval is insufficient. Retain previous identity/first-seen and historical mining association in scanner-owned state across rewind; publish revoked receipts with `canonical=false`, not fabricated current mining evidence. The SQL read never sets `complete=true` or `health='ready'`: those require the scan/enhancement and before/after tip barriers in Task 3.

### 3.1b Chain identity and consensus fingerprint v1 — Task 2 contract, Task 3 enforcement

Resolves the Task 3 live-preflight blocker (`task-3-report.md`, "Owned live-proof preflight"): the contract previously said only "digest of pinned activation parameters". The canonical definition below is frozen. Changing it requires a new domain version, not a silent edit.

- **Preimage.** UTF-8, LF line endings, no trailing whitespace, exactly 12 lines:
  `sovereign-storefront.consensus-fingerprint.v1`, `network=<regtest|test>`, then one `<name>=<height|none>` line for each name in this fixed protocol order (not alphabetical): `overwinter, sapling, blossom, heartwood, canopy, nu5, nu6, nu6-1, nu6-2, nu6-3`. Each line, including the last, ends in `\n`.
- **Digest.** `consensusFingerprint = lowercase hex(SHA-256(preimage))`, 64 characters.
- **Heights.** Base-10 activation heights as unsigned 32-bit integers, with no sign, leading zeros or quotes. `overwinter`…`nu6` are required and must have a height. `nu6-1`, `nu6-2` and `nu6-3` are `none` when the node does not schedule them; an absent optional key is the same as `null`. A pending upgrade that the node schedules at a height is recorded with that height, because it is part of the pinned consensus rules; `none` means "not scheduled", never "not yet reached". Heights never decrease in protocol order, and no upgrade may have a height after a `none` upgrade.
- **Rejected, never fingerprinted:** an unknown upgrade name (including a later `nu7`/Tachyon, or display spellings such as `nu6_1`/`NU6.1`), a missing or unactivated required upgrade, non-integer or out-of-range heights, a decreasing or gapped schedule, and `main`. A backend that reports an upgrade outside this list makes provisioning fail. Supporting it requires fingerprint v2.
- **genesisHash** is the block-0 hash in RPC display order (`getblockhash 0`), observed from the owned node at provisioning time. It is not part of the fingerprint preimage. The two fields are compared independently.
- **Shared vectors:** `services/scanner/protocol/fixtures/consensus-fingerprint-v1.json` (valid preimage/digest pairs computed independently with `sha256sum`, plus invalid schedules). Rust `tests/consensus.rs` and TypeScript `tests/unit/consensus-fingerprint.test.ts` must both pass on the same file.
- **Enforcement points.** (1) Rust `open_runtime_paths` derives the fingerprint from `runtime.activations` and rejects a config whose `chain.consensusFingerprint` differs, before creating any state (`consensus::consensus_fingerprint`). The config value is therefore a checked binding, not an operator-chosen label. (2) Every scanner lifecycle cycle calls lightwalletd `GetLightdInfo` and requires its `saplingActivationHeight` to equal the configured Sapling height, and its `consensusBranchId` to equal the pinned `BranchId::for_height(params, reportedTip)`. On a mismatch the cycle fails and the snapshot becomes unavailable (`consensus::verify_lightd_consensus`). The node/lightwalletd chain label is NOT trusted, because local Zakura regtest may report `test`. (3) Seller and runtime configuration (Task 10) derives `expectedChain.consensusFingerprint` with `src/contracts/consensus.ts` from the configured activation schedule and never accepts a raw digest. Then the existing adapter/database chain equality checks bind snapshots and allocations to the same schedule.
- **Implementation status (2026-09-24):** the enforcement for (1) and (2) is implemented and deterministic tests are GREEN; see `task-3-report.md` "Consensus fingerprint v1 — blocker fix". Enforcement (3) is a Task 10 obligation. Nothing here is live-chain evidence.

### 3.2 Invoice and store

Keep `Invoice` in `types.ts`, change `network` to `Network`, add `paymentUri: string` and a discriminated attribution field:

```ts
export type InvoiceAttribution =
  | { kind: 'receiver'; allocationId: string; receiver: ReceiverRef }
  | { kind: 'legacy-memo'; reference: string };
export type InvoiceDraft = {
  id: string; orderId: string; productVersion: string; buyerKeyId: string;
  chain: ChainIdentity; accountId: string;
  amountZat: string; createdAt: number; expiresAt: number;
};
export type ReconciledCheckpoint = {
  sourceId: string; generation: string; tip: { height: number; hash: string };
  checkedAt: number;
};
export type Disclosure = 'none' | 'attempted' | 'transport-accepted' | 'buyer-acknowledged';
export type DeliveryAttempt = {
  attemptId: string; orderId: string; packageId: string;
  reason: 'initial' | 'recovery'; checkpoint: ReconciledCheckpoint | null;
};
```

Remove live dependence on `attributionRef`; migrate existing values into `legacy-memo`. Add `invoiceId` directly to `InvoiceSettlement` instead of inferring it from its backing outputs. Extend `BrowserPurchase` with a versioned immutable quote (`network`, `amountZat`) before request submission; retain old-record import compatibility with no automatic conversion of ambiguous network data.

Final new `SellerStore` operations, implemented in Task 2 before fanning out:

```ts
reserveInvoice(input: {
  orderId: string; buyerKeyId: string; productVersion: string;
  chain: ChainIdentity; accountId: string; now: number; ttlMs: number;
}): Promise<InvoiceDraft>;
commitInvoice(draftId: string, allocation: ReceiverAllocation): Promise<Invoice>;
getInvoiceDraft(orderId: string): Promise<InvoiceDraft | null>;
getScanSnapshot(): Promise<ScanSnapshot | null>;
commitSnapshot(input: {
  snapshot: ScanSnapshot; observations: Observation[];
  settlements: InvoiceSettlement[];
}): Promise<void>;
beginDeliveryAttempt(input: Omit<DeliveryAttempt, 'attemptId'>): Promise<DeliveryAttempt>;
finishDeliveryAttempt(attemptId: string, outcome: 'transport-accepted' | 'failed'): Promise<void>;
getDisclosure(orderId: string): Promise<Disclosure>;
acknowledgePackage(orderId: string, packageId: string): Promise<void>;
recordMessage(input: {
  signer: string; messageId: string; operation: string;
  payloadDigest: string; expiresAt: number;
}): Promise<'new' | 'duplicate'>;
```

Retain existing `getInvoice`, `listInvoices`, `listObservations`, package, exception and close operations. `Observation` remains the seller projection but gains `sourceId` and `generation`; `revision.id` is the exact chain tip hash. `getCheckpoint` returns `ReconciledCheckpoint`; use `commitSnapshot`, not the old per-observation commit, for live reconciliation. Store snapshot/observations/settlements/checkpoint in ONE transaction. On rollback, in-memory state stays unchanged. Check expected source + generation at commit. An identical generation must contain identical evidence; a larger generation may have a lower block height. Snapshot omission revokes previous outputs within that source/account.

New tables: `invoice_drafts`, `receiver_allocations`, `scan_snapshots` (one current complete body plus checkpoint), `delivery_attempts`, `message_inbox`, `schema_migrations`. Add source/generation columns to observations, explicit invoice FK to settlements, and disclosure/package identity persistence. Uniqueness: order→draft/invoice, allocation ID, chain/account/pool/receiver, chain/txid/pool/index. Existing tables are migrated transactionally, not recreated with data loss. `openCatalogue` and `openStore` call the same migration entrypoint before accessing data.

`reserveInvoice` reads immutable published-product terms inside its transaction; it cannot use fallback amount/address. An existing draft always wins over changed current catalogue/config. Allocation is outside the seller SQL transaction. `commitInvoice` checks the entire allocation against the draft and returns the existing identical invoice on retry.

### 3.3 Messaging and application service

Create `src/contracts/messages.ts`. Use a discriminated union, not unvalidated arbitrary JSON:

```ts
export type RequestHeader = {
  version: 1; messageId: string; sellerKeyId: string;
  network: Network; issuedAt: number; expiresAt: number;
};
export type BuyerRequest = RequestHeader & (
  | { type: 'create'; requestId: string; productVersion: string;
      expectedAmountZat: string }
  | { type: 'status'; orderId: string }
  | { type: 'recover'; orderId: string }
  | { type: 'acknowledge'; orderId: string; packageId: string }
);
export type SellerResponse = {
  version: 1; messageId: string; inReplyTo: string;
  sellerKeyId: string; buyerKeyId: string; network: Network;
  issuedAt: number; expiresAt: number;
} & (
  | { type: 'invoice'; invoice: Invoice }
  | { type: 'status'; orderId: string; status: OrderStatus }
  | { type: 'delivery'; packageId: string; package: DeliveryPackage }
  | { type: 'acknowledged'; orderId: string; packageId: string }
  | { type: 'error'; code: 'unavailable' | 'invalid' | 'forbidden' | 'not_eligible' }
);
export type AuthenticatedRequest = { signerKeyId: string; body: BuyerRequest };
export type DecodedWakuMessage = {
  signerKeyId: string; body: BuyerRequest | SellerResponse;
  wireEnvelope: Uint8Array; // opaque original bytes, retained for later library verification
};
export type StoredDelivery = { packageId: string; wireEnvelope: Uint8Array };
export interface SellerApplication {
  handle(request: AuthenticatedRequest): Promise<SellerResponse>;
}
export interface WakuSession {
  ready(): Promise<boolean>;
  send(recipientKeyId: string, body: BuyerRequest | SellerResponse): Promise<void>;
  subscribe(handler: (message: DecodedWakuMessage) => Promise<void>): Promise<() => Promise<void>>;
  decodeStored(wireEnvelope: Uint8Array): Promise<DecodedWakuMessage>;
  close(): Promise<void>;
}
```

`signerKeyId` comes from verified ECIES decoding, never JSON. Use a dedicated seller-signed `delivery` body with `inReplyTo=''` for unsolicited dispatch; the buyer requires a locally owned order/buyer/product/package match and deduplicates by package ID. Responses to requests require exact `inReplyTo` and expected operation. Serialization/base64 of byte arrays belongs to the versioned wire codec; public metadata remains generic. `decodeStored` repeats library decryption/signature verification and shape validation; historical envelopes may be past their online response TTL, but never bypass seller/order/buyer/product bindings. Online replay/expiry checks remain mandatory for newly received network messages.

Task 2 extends `PurchaseStore` with `saveDelivery(orderId: string, record: StoredDelivery): Promise<void>` and `getDelivery(orderId: string): Promise<StoredDelivery | null>`. Task 9 implements IndexedDB persistence and versioned backup handling. The Waku transport receives the purchase store so it can durably save authenticated delivery before sending acknowledgement. A stored decoded JSON body without its verifiable envelope is not a trusted delivery cache.

Credential changes: `publicKey(credentialId): Promise<string>` and an adapter-owned `createWakuSession(credentialId, config: WakuConfig): Promise<WakuSession>` that obtains its key internally. `WakuConfig = { contentTopic: string; bootstrapPeers: string[]; peerTimeoutMs: number }`. Seller uses the same session factory with its persistent identity imported privately. No extra application-layer signature implementation or raw-private-key getter. Retain existing delivery decryption/backup primitives.

Replace fixture-shaped `FulfillmentMessaging` arrays in the production contract with `send(pkg: DeliveryPackage, packageId: string): Promise<void>` and `ready(): Promise<boolean>`. Memory-only introspection stays on its returned fixture type. `send` resolution means transport acceptance only; it cannot set buyer acknowledgement. Both `dispatchPending()` and `recover(orderId, buyerKeyId)` use `authorizeRelease` and the delivery-attempt journal. Remote handlers authenticate the signer against invoice ownership, not `provePossession` using a server-side buyer credential ID. `OrderTransport` gains `acknowledge(orderId, credentialId, packageId): Promise<void>`.

### 3.4 Named pure helpers / fixture factories

Task 2 creates `src/contracts/live-validation.ts` with `validateSnapshot(value: unknown): ScanSnapshot`, `validateAllocation(value: unknown): ReceiverAllocation`, `sameReceiver(a: ReceiverRef, b: ReceiverRef): boolean`, `eligibleSnapshot(snapshot: ScanSnapshot, now: number, maxAgeMs: number): boolean`. `sameReceiver` compares account/scope/pool/receiver bytes, not UA spelling or derivation index.

Create `tests/support/live-fixtures.ts` defining `fixtureSnapshot(overrides?: Partial<ScanSnapshot>): ScanSnapshot`, `fixtureAllocation(overrides?: Partial<ReceiverAllocation>): ReceiverAllocation`, and `fixtureInvoice(overrides?: Partial<Invoice>): Invoice`. Default clock: `1_000_000`; network regtest; complete/ready snapshot generation `'1'` with equal tip/scanned at height 20; an external Orchard allocation; a single 100,000,000-zat invoice expiring at `2_000_000`. Use valid generated test-only address material for parser tests rather than prefix-only fabricated UAs. These helpers are deterministic fixtures, never live evidence.

## Task 0: Isolate secrets and eliminate stale build evidence

**Files:** Modify `.gitignore`, `package.json`; create `scripts/clean-build.mjs`, `tests/unit/build-provenance.test.ts`. No running services yet.

**Consumes:** Existing build scripts. **Produces:** `npm run build:clean`; generated `dist/build-info.json` with source commit, dirty-diff digest, source manifest digest, build timestamp and adapter entrypoint paths. Task 10 fills actual runtime versions, not this build script.

- [ ] Write a test that plants `dist/service/adapters/orphan-probe.js`, runs the clean build, then proves that file is absent and the built `main.js` comes from the current source manifest. Test uses a disposable copy or serial invocation to avoid racing other builds.

```ts
expect(existsSync('dist/service/adapters/orphan-probe.js')).toBe(false);
expect(JSON.parse(readFileSync('dist/build-info.json', 'utf8')).sourceCommit)
  .toBe(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
```

- [ ] Run the test; expect failure before the clean-build implementation.
- [ ] Add explicit ignores for `.runtime/`, scanner `target/` and test-wallet runtime/target directories before provisioning. Keep Cargo.lock trackable. Runtime directories 0700; wallet/config/identity files 0600. Do not overwrite existing untracked artifacts.
- [ ] Implement `clean-build.mjs` using `rmSync('dist', { recursive: true, force: true })`, then checked child-process execution of the existing browser/service build scripts and provenance generation. Only remove repository-owned generated `dist`.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build:clean`, `npm run test:browser`. Record actual counts/errors. Verify `git diff --check`. No git commit unless separately authorized.

**Done:** A clean build cannot retain the orphan `dist/service/adapters/live.js` or `zakura-scanner.js` from past work. Secret paths are protected before any wallet probe.

## Task 1: Qualify the wallet consumer and independent receiver evidence

**Files:** Create `services/scanner/Cargo.toml`, `Cargo.lock`, `src/lib.rs`, `src/main.rs`, `src/config.rs`, `src/wallet.rs`, `src/allocate.rs`, `src/scan.rs`, `tests/qualification.rs`, `tools/payment-test-wallet/Cargo.toml`, `tools/payment-test-wallet/src/main.rs`, `scripts/qualify-payments.ts`, `docs/scanner-qualification.md`.

**Consumes:** Pinned repository sources and a demo-owned local chain. **Produces:** executable scanner `qualify --config FILE`, separate test-wallet provisioning helper, a compiled locked consumer graph and an independently scanned two-invoice proof. These scanner modules are retained/extended in Task 3, not a throwaway ths adapter.

- [ ] Add Rust tests for wrong-network UFVK, missing Orchard viewing capability and two allocation IDs producing distinct external receivers. Create a disposable seller wallet in the SEPARATE test helper and write its UFVK/birthday to scanner-only configuration. Never read a ths seed or print provisioning secrets.
- [ ] Start with the actual recommended package aliases:

```toml
[dependencies]
zcash_client_backend = { package = "zakura-client-backend", version = "=0.1.0-rc5", features = ["orchard", "sync", "lightwalletd-tonic-transport", "lightwalletd-tonic-tls-webpki-roots"] }
zcash_client_sqlite = { package = "zakura-client-sqlite", version = "=0.1.0-rc5", features = ["orchard"] }
```

Read the published manifests and pinned wallet examples to add only actually used matching `zcash_keys` alias, protocol/ZIP-321, serde, runtime and database dependencies. Cargo metadata is the source of resolved versions. Match the library's tonic/rusqlite versions; do not independently choose incompatible API versions. Avoid a blanket `[patch.crates-io]` or `--all-features`.

- [ ] Generate the lockfile, then run `cargo check --locked --manifest-path services/scanner/Cargo.toml` and `cargo metadata --locked --format-version 1 --manifest-path services/scanner/Cargo.toml`. Audit package names AND sources against the wallet repository's graph-verification rules. Standard unrenamed protocol crates are allowed; duplicate upstream copies of renamed crypto crates are not.
- [ ] Implement network-aware UFVK import using `WalletWrite::import_account_ufvk` / `AccountPurpose::ViewOnly`, persisted address allocation using `get_address_for_index` or its verified equivalent, block cache + `sync::run`, and received-note projection sufficient for the qualification test. Read the exact signatures at the audited revision linked in the analysis; compile each use rather than infer arguments from names.
- [ ] Discover/install/check ths only when execution is authorized; use `ths doctor --json` and dynamically discovered endpoints. Record exact image/version/activation parameters. Append concrete ths observations to the zakura-regtest DX backlog. Keep ths invocations in `scripts/qualify-payments.ts`, never scanner or application modules.
- [ ] Implement harness CLI `node --experimental-strip-types scripts/qualify-payments.ts --config "$SSF_SCANNER_CONFIG_FILE"`. It funds only allocation A from a two-equal-price set, mines as needed and waits with bounded deadlines. The faucet result is only a payer diagnostic. The scanner independently supplies amount, receiver, txid/pool/action index and canonical mining data.
- [ ] Test required latest-block, tree-state, compact-block, subtree-root (including Ironwood requests in this library), full-transaction and status calls. Unsupported mandatory methods FAIL qualification. Use a genuinely compatible endpoint/library release only after documenting and re-running the entire matrix; no mocked success or swallowed unsupported error.
- [ ] Assert zero eligible A outputs before ten confirmations, one after ten, no payment for B, and the same receipt/allocation after restarting scanner. In this gate eligibility is a projection check, not a claim that storefront fulfillment already ran.

```rust
assert_ne!(allocation_a.receiver_hex, allocation_b.receiver_hex);
assert_eq!(owned_a.amount_zat, "100000000");
assert_eq!(owned_a.receiver_hex, allocation_a.receiver_hex);
assert!(owned_for_b.is_empty());
assert_eq!(before_restart.output_id, after_restart.output_id);
```

- [ ] Write sanitized `docs/scanner-qualification.md`: package/source/feature graph, node/lightwalletd identities, chain fingerprint, exact commands with secret file paths only, RPC support matrix and observed receipt fields. Report PASS only from actual tool execution.

**Done / stop rule:** Correct independent receipt evidence and qualified dependency graph, or a concrete blocker. If this gate fails, do NOT proceed to a purported live payment release. Waku/storage research can continue, but no same-day live completion promise.

Task 1 PASS is a narrow two-invoice receiver/confirmation/restart qualification, not proof of complete spent/noncanonical history or a running scanner daemon. Task 3 must exercise the full pinned history projection and actual `serve` + adapter path; do not reuse the narrow unspent-note qualification as that evidence.

## Task 2: Freeze contracts, migrations and deterministic compatibility

**Files:** Create `src/contracts/live.ts`, `messages.ts`, `live-validation.ts`, `src/seller/migrations.ts`, `tests/support/live-fixtures.ts`, `tests/unit/live-contracts.test.ts`, `tests/unit/migrations.test.ts`; modify `types.ts`, `validation.ts`, `schema.sql`, `db.ts`, `invoices.ts`, `orders.ts`, `catalogue.ts`, `config.ts`, `adapters/scanner.ts`, `adapters/messaging.ts`, `adapters/credentials.ts`, browser purchase types and affected existing tests. Own root `package.json`/lockfile changes.

**Consumes:** Task 1's verified receiver and snapshot projection fields. **Produces:** Every contract/operation in Section 3 with real persistence implementations, migration fixtures and final compileable interfaces for all tracks. This task includes mechanical call-site shape migration; policy hardening belongs to Task 5.

- [ ] Write tests for exact network/chain/account binding, fake/truncated/future snapshots, receiver uniqueness and atomic rollback. Include `BEGIN IMMEDIATE` failure after observations and before checkpoint with per-openStore injection; reopen and verify neither changed.

```ts
const old = fixtureSnapshot({ generation: '7' });
const rewind = fixtureSnapshot({ generation: '8',
  tip: { height: 15, hash: 'b'.repeat(64) },
  scanned: { height: 15, hash: 'b'.repeat(64) } });
expect(eligibleSnapshot(old, 1_000_000, 120_000)).toBe(true);
expect(eligibleSnapshot({ ...old, checkedAt: 1_000_001 }, 1_000_000, 120_000)).toBe(false);
// Store must accept the later generation, not reject its lower height.
await store.commitSnapshot({ snapshot: old, observations: [], settlements: [] });
await store.commitSnapshot({ snapshot: rewind, observations: [], settlements: [] });
expect((await store.getScanSnapshot())?.generation).toBe('8');
```

- [ ] Run `npx vitest run tests/unit/live-contracts.test.ts tests/unit/migrations.test.ts`; verify the failures target absent validation/migration behavior.
- [ ] Implement all Section 3 schema/types/store primitives and `migrateStore(db)` called from every opening path. Use a v1 database fixture with products, invoice, prepared package, observation and identity. Retain immutable data; mark old invoices `legacy-memo`; ambiguous network migration refuses live startup, not silent inference.
- [ ] Create byte-accurate Rust/TypeScript JSON contract vectors under `services/scanner/protocol/fixtures/` and validate them from both languages. No UFVK/keys in vectors. Validate positive price <= monetary bounds, 11-byte diversifier encoding, actual decoded receiver length, string/ciphertext/body bounds, discriminated request/response shape and generation formatting.
- [ ] Implement serial fixture compatibility with the final `ReceiptSource` shape and common message codecs. Update existing tests without weakening their authorization, recovery or integrity assertions. Existing payment functions may mechanically map snapshots during this task, but `real-demo` remains gated until Tasks 5/10.
- [ ] Add exact Waku SDK pin from Gate A. Select/install a maintained local QR encoder plus test decoder (candidate `qrcode` and `jsqr`), inspect exports/types/license, and record exact resolved versions in the lockfile. Add only required direct dependencies, including any noble import currently obtained transitively. No CDN QR service.
- [ ] Run `npm test && npm run typecheck && npm run build:clean` and Rust schema-vector tests. Hand every worker the frozen contracts and exclusive file list.

**Done:** No parallel worker must invent a store method, request field, receiver encoding or schema migration. No real service is yet claimed integrated.

## Task 3: Complete the persistent viewing-only scanner service

**Files:** Extend Task 1's `services/scanner/src/{main,config,wallet,allocate,scan}.rs`; create/complete `enhance.rs`, `projection.rs`, `snapshot.rs`, `api.rs`, `tests/{projection,snapshots,allocation,api,restore}.rs`, `protocol/schema.json`; create/complete `src/adapters/wallet-scanner.ts`, `tests/unit/wallet-scanner.test.ts`; create `docs/scanner-projection-compatibility.md`.

**Consumes:** Section 3.1/schema vectors. **Produces:** `createWalletScanner({ socketPath, expectedChain, accountId }): ReceiptSource`; scanner `serve --config FILE`, `init-view --config FILE`; private `POST /v1/allocations` and `GET /v1/snapshot`. Unknown routes, remote binds and secret-return endpoints are rejected.

**Projection deliverable:** Section 3.1a's Rust-only `read_wallet_history`, pinned-schema compatibility checks, scanner-owned retained history, and migrated-wallet projection tests. Read-only wallet SQL with the necessary documented joins is explicitly permitted; direct application writes to wallet tables, TypeScript wallet SQL, test-only production APIs and unspent-only history are forbidden. A brief/report saying all wallet SQL is forbidden is incorrect and must be reconciled with this section before escalation.

- [x] Inspect Cargo-resolved rc5 sources and implement tests against disposable databases initialized/migrated by that exact library, not a hand-invented lookalike schema. Record package checksums, enabled production features, migration identity and the exact required view/table columns in `docs/scanner-projection-compatibility.md`. Verify the query against the real initialized schema; inject incompatible/missing columns only in disposable negative-test copies. Validate required schema/migration identity before reading runtime receipts; reject drift, never adapt SQL silently. Verified 2026-09-24: recorded in `docs/scanner-projection-compatibility.md`.
- [x] Add the following RED cases to `tests/projection.rs`, exercising the real SQL reader and snapshot publication seam, not only `ProjectedOutput` model objects. Verified 2026-09-24: implemented in `services/scanner/src/projection_tests.rs` (a `#[cfg(test)]` module rather than a separate `tests/projection.rs` integration target) under more descriptive names; see `.superpowers/sdd/2026-09-23-live-mvp-integration/task-3-brief.md` for the exact name mapping.

| Test | Concrete fixture/action | Required assertion |
| --- | --- | --- |
| `spent_receipt_survives_restart` | Two selected-account external Orchard receipts; mark one spent through a library-backed fixture, then reopen | Both output identities/amounts/receivers remain; original `firstSeenAt` survives |
| `received_ownership_and_scope` | One selected external receipt, one foreign-account receipt, one internal note with no address, and one sent-only row | Exactly the selected external receipt is eligible; internal/sent/foreign rows never acquire invoice attribution |
| `unresolved_external_receiver_blocks_ready` | Selected-account candidate with missing scope, conflicting scopes, or missing/invalid external Orchard address | Publication cannot be complete/ready; no silent row omission |
| `rewind_retains_revoked_history` | Observe a mined receipt, invoke wallet-library rewind below it, reopen and reconcile | Same output ID and `firstSeenAt`, `canonical=false`, higher generation, no stale mining evidence enabling release; repeat a same-height fork |
| `retrieved_height_is_not_scanned_evidence` | Receipt has `mined_height` but null `block`, or enhancement remains pending | No canonical confirmed receipt/ready publication until scanned hash and enhancement barriers pass |
| `schema_drift_is_unavailable` | Remove/change a required projection column or migration identity in a disposable copy | Typed unavailable result; no empty complete snapshot or SQL fallback |

- [x] Run `cargo test --locked --manifest-path services/scanner/Cargo.toml --test projection`; require failures at the missing projection/behavior before implementation. Tests may construct synthetic wallet state ONLY in disposable fixtures and must label it deterministic, not live evidence. Then implement Section 3.1a, run the same tests to GREEN, and keep the existing snapshot/allocation regressions. Verified 2026-09-24.

- [x] Write Rust tests: persisted index reservation survives crash between reserve/derive/finalize; changed allocation terms fail; spent receipt remains; foreign account/internal change/sent rows are excluded; reorg keeps historical identity but revokes canonicality; missing enhancement data cannot publish ready. Verified 2026-09-24.
- [x] Run `cargo test --locked --manifest-path services/scanner/Cargo.toml` and `npx vitest run tests/unit/wallet-scanner.test.ts`; verify failing assertions before implementation. Verified 2026-09-24: 84 Rust tests, 5 TS tests pass.
- [x] Implement allocator journal in scanner-owned application SQLite, separate from wallet-owned tables. Serialize reservation/finalization with a service mutex; use wallet persisted derivation at the reserved index, not a new index per retry. Keep account/chain/pool/scope/receiver mappings and a burned-index high-water mark. Verified 2026-09-24: `src/allocate.rs`.
- [x] Implement bounded compact-block cache and sync worker. Execute `transaction_data_requests` through full transaction fetch, `decrypt_and_store_transaction` and status updates; retry with capped backoff. Implement Section 3.1a's read-only `v_received_outputs` projection in `projection.rs` with explicit account/scope/receiver checks and retained spent/noncanonical history. Move Task 1's wallet SQL into this boundary and remove its unspent-note dependency from the production history path. Library writes remain separate from the read-only projection connection; quiesce them for the coherent read transaction. Do not use an unspent balance query or test-only history API. Verified 2026-09-24: `src/cache.rs`, `src/enhance.rs`, `src/projection.rs`; live-proven end to end.
- [x] Implement full snapshot publication with monotonic durable generation. Quiesce wallet writes while taking the coherent read; compare tip identity before/after, publish ready only after required scan ranges/enhancement finish. Every changed snapshot, including refreshed checkedAt, gets a new persisted generation; replaying the same generation returns byte-equivalent evidence. Persist `firstSeenAt`; derive output/action index from wallet data. Never synthesize index zero. On invalidation publish non-ready/revoked evidence before reopening release eligibility. Verified 2026-09-24: `src/snapshot.rs`; live-proven, generation advanced across real lifecycle cycles.
- [x] Implement Unix socket permissions, bounded request/body sizes and timeouts; prevent concurrent daemon writers to a wallet DB. Rust config rejects mainnet, unknown/missing/out-of-order activation parameters, a `chain.consensusFingerprint` not derived per Section 3.1b, and plaintext non-loopback lightwalletd; each lifecycle cycle verifies lightwalletd's Sapling height and tip branch ID against the configured schedule. TS adapter validates every response and pins chain/account/source across calls; socket failures throw typed unavailable errors. Verified 2026-09-24: `src/api.rs`, `src/lease.rs`, `src/config.rs`, `src/consensus.rs`, `src/adapters/wallet-scanner.ts`; live-proven.

```ts
expect(() => validateSnapshot({ ...fixtureSnapshot(), complete: false }))
  .not.toThrow(); // valid wire shape, but not eligible
expect(eligibleSnapshot({ ...fixtureSnapshot(), complete: false }, 1_000_000, 120_000))
  .toBe(false);
expect(sameReceiver(fixtureAllocation().receiver, {
  ...fixtureAllocation().receiver, receiverHex: '00',
})).toBe(false);
```

- [x] Define and enforce consensus fingerprint v1 (Section 3.1b): Rust `consensus.rs` derivation plus config binding and per-cycle lightwalletd check, TypeScript `src/contracts/consensus.ts`, and shared vectors. Deterministic only (2026-09-24).
- [x] Add a narrow private runtime-config provisioner, `scripts/provision-scanner-runtime.ts` (a Task 3-owned exception for this one script), for an owned local regtest only. Inputs are the existing helper-written `{ufvk, birthday}` config path plus dynamically discovered node RPC and lightwalletd endpoints. It reuses `localRegtestParametersFromRpc` for `getblockchaininfo.upgrades`, additionally requires each upgrade's object key (branch ID) to match that name's pinned branch ID, maps `nu6_1`→`nu6-1` (and so on), and fails on any unmapped upgrade. It reads `getblockhash 0` for `genesisHash`, and lightwalletd `GetTreeState(birthday - 1)` for `birthdayTree`. It derives `consensusFingerprint` with `src/contracts/consensus.ts` and never takes a digest argument. It rewrites the config atomically with mode `0600`, adding `runtime.{sourceId, chain, lightwalletd, activations}` and `birthdayTree`, and prints only status and field names, never values. Before writing, it checks that lightwalletd's `GetLightdInfo` Sapling height/branch agree with the schedule. RED tests: unmapped upgrade, branch-ID/name mismatch, missing required upgrade, non-private directory, existing runtime section, and fingerprint equality with the shared vector for the Task 1 schedule shape. Verified 2026-09-24: implemented and used successfully to provision the live owned-proof run.
- [x] Run Rust fmt/check/test/clippy with locked dependencies and selected production features. Repeat Task 1's live proof using `serve` plus the TypeScript Unix-socket adapter, not the qualification CLI's in-process reader. Verified 2026-09-24: `cargo fmt/test/check/clippy -D warnings` all clean (84 tests); owned `init-view`→`serve`→TS-adapter live proof achieved (funded, scanned, enhanced, published, restart-durable); stack cleanly torn down afterward.

- [x] Record exact schema-test, history-test and daemon/adapter proof commands/results in `docs/scanner-projection-compatibility.md`, with deterministic and live evidence separated. Check that all custom runtime wallet-SQL reads are confined to `projection.rs`, the projection connection is read-only, and no production test-only wallet feature is enabled. A remaining blocker must identify the exact missing column/semantic invariant or failing runtime behavior after trying the permitted path; `get_tx_history` E0599 alone is not such a blocker. Verified 2026-09-24: doc updated with the live daemon/adapter proof section and the disclosed reorg-detection limitation.

**Task 3 status (2026-09-24): functionally complete.** One disclosed, user-deferred open limitation remains: `zakura-client-sqlite`/`zakura-client-backend`'s `update_chain_tip` has a bounded reorg-detection blind window (proven live via real `invalidateblock` + remine; closes automatically once a replacement chain grows taller than the pre-reorg max-scanned height, via the library's own `PrevHashMismatch`-triggered rewind-and-rescan — that automatic recovery was not itself empirically confirmed live this session). User decision: "skip it for now." Full mechanism, live-proof values and two remediation options are recorded in `.superpowers/sdd/2026-09-23-live-mvp-integration/task-3-report.md`. This is a known product-risk item, not a Task 3 blocker, and does not by itself gate Task 4/5.

**Done:** Restartable independent scanner, pinned migrated-schema projection tests, complete incoming history and observable invalidation, plus actual `serve` + TypeScript adapter evidence. Read-only Rust wallet projection is allowed and isolated; TypeScript wallet SQL, application writes to wallet tables and ths receipt dependency remain forbidden. Model tests and the older qualification CLI alone cannot complete Task 3.

## Task 4: Issue immutable unique-receiver invoices

**Files:** Create `src/seller/issuance.ts`, `tests/unit/issuance.test.ts`; modify `src/seller/invoices.ts`, `services/scanner/src/allocate.rs` and `services/scanner/tests/allocation.rs` for URI generation/round-trip tests; extend store implementations only within Task 2's frozen API if bugs are found. Task 3 finishes before these scanner edits.

**Consumes:** `SellerStore`, `ReceiptSource.allocateReceiver`, exact product availability. **Produces:**

```ts
export function createInvoiceIssuer(deps: {
  store: SellerStore; scanner: ReceiptSource; chain: ChainIdentity;
  accountId: string; ttlMs: number; now: () => number;
  availability: (productVersion: string) => Promise<ServiceAvailability>;
}): { issue(input: {
  requestId: string; buyerKeyId: string; productVersion: string;
  expectedAmountZat: string;
}): Promise<Invoice> };
```

- [x] Write tests for two equal-price purchases, concurrent same-request calls, a crash after scanner allocation but before invoice commit, and loss of invoice response. Reopen both stores; assert SAME id, amount, destination, attribution, product version and expiry for retries. New request IDs get new credentials/receivers. Verified 2026-09-24: `tests/unit/issuance.test.ts`.

```ts
const first = await issuer.issue(request);
const replay = await restartedIssuer.issue(request);
expect(replay).toEqual(first);
expect(replay.attribution.kind).toBe('receiver');
expect(replay.paymentUri).not.toContain('memo=');
await expect(issuer.issue({ ...request, expectedAmountZat: '1' }))
  .rejects.toThrow('request terms changed');
```

Test-local `request` contains requestId, buyerKeyId, productVersion and expectedAmountZat; `issuer`/`restartedIssuer` use the factory above and real temporary seller stores plus Task 2's deterministic allocation fixture. Live allocator crash behavior is separately covered in Task 3.

- [x] Run `npx vitest run tests/unit/issuance.test.ts` and confirm red. Verified 2026-09-24: RED confirmed (module did not exist) before implementation.
- [x] Implement replay lookup first, ownership/terms verification, per-product availability, `createOrder` → `reserveInvoice` → allocator → `commitInvoice`. Never hold a seller SQL transaction across scanner/network I/O. Existing issued invoices replay through outages; new issuance cannot bypass known unavailable dependencies. Verified 2026-09-24: `src/seller/issuance.ts`.
- [ ] Generate ZIP-321 via the compatible Rust `zip321` crate at allocation, using canonical zatoshi conversion and the validated shielded UA. Parse it back in Rust before returning. The seller binds URI to amount/destination, and the browser displays exactly these signed terms. Status 2026-09-24: already implemented in `services/scanner/src/wallet.rs` (`zip321_payment_uri`) as part of Task 1/3; the TypeScript adapter (`src/adapters/wallet-scanner.ts::validatePaymentUri`) independently re-derives and compares the canonical amount string before returning the allocation to the issuer. Not re-verified again in this pass beyond the existing `wallet.rs` test at line 600 and the adapter's own tests.
- [x] Test expiry/late observation without receiver reuse, wrong chain/account allocation, transparent/malformed receiver, mixed-network catalogue, and missing product rejection (no default 1-ZEC fallback). Verified 2026-09-24: mixed-network and missing-product covered directly in `tests/unit/issuance.test.ts`; malformed/transparent receiver bytes are rejected by `validateAllocation` (`tests/unit/live-contracts.test.ts`, Task 2); wrong chain/account allocation is rejected both by `MemoryScanner.allocateReceiver` (fixture) and by `commitInvoice`'s immutable-draft comparison in `src/seller/db.ts`; receiver non-reuse is enforced by the Rust allocator's burned-index high-water mark and the `receiver_allocations` uniqueness constraint (Task 3), not re-derived at the TS issuance layer.
- [x] Run issuance/invoice/order tests, `npm run typecheck`, and the Rust URI tests. Keep legacy records read-only/recoverable, not automatically payable under the new strategy. Verified 2026-09-24: `npm test` 159/159 pass, `npm run typecheck` clean, `npm run build` clean, `cargo test --locked` 84/84 pass. Fixed a real pre-existing defect found during this task: `src/seller/invoices.ts::readInvoiceByOrder`/`listInvoices` never selected the v2 receiver-attribution columns (`attribution_kind`, `attribution_data`, `payment_uri`, `chain_genesis_hash`, `consensus_fingerprint`, `account_id`), so a committed receiver invoice was silently read back as a legacy-memo invoice on replay/restart — fixed to branch on `attribution_kind` and hydrate the real receiver attribution/chain/account/paymentUri.

**Task 4 status (2026-09-24): functionally complete** for the issuance path itself (`createInvoiceIssuer`, replay/crash/concurrency/availability/network-mismatch coverage, and a real invoice-read defect fixed). Not independently re-verified in this pass: the ZIP-321 URI generation itself (already implemented in Task 1/3, unchanged here).

**Done:** No invoice is displayed until its immutable terms and allocation are durable; no ambiguous amount or UA-string matching.

## Task 5: Reconcile snapshots and harden disclosure/recovery

**Files:** Modify `src/seller/payments.ts`, `fulfillment.ts`, necessary `db.ts` implementations; extend `tests/unit/{payments,invoice-reduce,fulfillment}.test.ts`; create `tests/unit/snapshot-reconciliation.test.ts`, `tests/unit/disclosure.test.ts`.

**Consumes:** Complete snapshots, invoice receiver mappings and delivery-attempt store. **Produces:** `createPayments` consuming `ReceiptSource`, existing `reconcileFromScanner/authorizeRelease/orderStatus`, and common dispatch/recovery release gate; no production per-observation injection method.

- [x] Add tests proving the current flaw: newer generation at lower height revokes a confirmed payment; same-height different hash prevents initial release; unrelated fresh health cannot authorize old receipts; missing receipt in complete snapshot revokes; partial snapshot does not commit; future checkedAt fails. Verified 2026-09-24: covered directly in the rewritten `tests/unit/payments.test.ts` (11 tests) and `tests/unit/fulfillment.test.ts` (11 tests), exercising real `MemoryScanner.snapshot()`/`replaceSnapshot` rather than per-observation injection; a receiver-ownership mismatch case (wrong-receiver receipt never confirms an unrelated invoice) replaces the originally sketched same-height-different-hash case since `MemoryScanner`'s fixture always keeps tip===scanned.
- [x] Run `npx vitest run tests/unit/snapshot-reconciliation.test.ts tests/unit/disclosure.test.ts` and confirm red. Verified 2026-09-24: no separate files were created; the flaw-proving cases were added directly to `tests/unit/payments.test.ts`/`fulfillment.test.ts` instead (both rewritten around the new snapshot contract), and RED was confirmed incrementally for each new/changed case during the rewrite, not as one combined red run against not-yet-existing files.
- [x] Replace `latestByOutputId`, `applyReceipt`, SQL height guards and height cursor logic with source/generation ordering. Fetch/validate a full snapshot, match receiver ownership, calculate `tip.height - mined.height + 1` only for canonical records under that snapshot, reduce every invoice over the complete deduplicated set, and atomically `commitSnapshot`. Persist checkpoint last in the transaction. Hydrate from persisted snapshot/observations on restart; never update caches before commit. Verified 2026-09-24: `src/seller/payments.ts::fetchAndCommitSnapshot` fetches one complete `ReceiptSource.snapshot()`, matches every receipt to a known invoice by `receiptMatchesInvoice` (receiver/chain/account identity, not injected invoiceId), computes confirmations from `tip.height - mined.height + 1` only for canonical receipts, reduces every receiver-attributed invoice, and calls `store.commitSnapshot` atomically (`src/seller/db.ts`, snapshot row plus observations/settlements in one transaction). `reduceInvoice`'s internal `latestByOutputId` dedup is retained (still needed to dedupe multiple observations of the same outputId within one snapshot), but the outer per-observation caching/injection path (`reconcileObservation`, incremental height-cursor merge) was deleted entirely from `payments.ts`.
- [x] Keep the reducer permutation-invariant: exact/overpayment may fulfill once, partials are not aggregated, duplicates flag surplus, late receipt uses persisted firstSeenAt, change/foreign/malformed receipts never match. Preserve paid delivery failure independently of payment. Store unmatched receipts as seller review data, not an exception on every unrelated invoice. Verified 2026-09-24: unchanged reducer logic re-verified GREEN via existing `tests/unit/invoice-reduce.test.ts` (13 tests, permutation-order pairs); unmatched receipts raise one `unmatched` exception scoped to no specific invoice's settlement path, not attached to every unrelated invoice.
- [x] `authorizeRelease` obtains/reconciles a fresh complete snapshot for first disclosure, under the same seller lock as settlement and attempt reservation. A previously prepared/queued package is not historical proof of sending. Derive `packageId` from immutable sealed-envelope bytes and bindings; persist intent before network I/O, acceptance afterward. Remove production dependence on `sendInitiatedFor` arrays. Verified 2026-09-24: `authorizeReleaseLocked` calls `fetchAndCommitSnapshot` then re-derives `releaseEligible` from a freshly reduced settlement (fixed a real bug where it previously inferred eligibility from stale `delivery==='prepared'` state alone); `packageId` was already derived from immutable envelope bytes in `src/seller/db.ts::immutablePackageId`/`savePreparedPackage`. `fulfillment.ts::dispatchPending` now calls `store.beginDeliveryAttempt` (persisting intent) before `messaging.send`, and only `finishDeliveryAttempt('transport-accepted')` plus `sent_unacknowledged` after a successful send; `sendInitiatedFor` is no longer read by production code (only by the `createMemoryMessaging` test fixture itself and directly by test assertions).
- [x] Require fresh eligibility for intent-only/failed attempts; allow explicit replay without scanner only for durable transport acceptance or buyer acknowledgement. Persist uncertainty, do not claim exactly-once delivery. Route background dispatch and Waku recover through the same operation. Recovery returns the actual package, even if periodic-send suppression already contains this order. Verified 2026-09-24: an intent-only/failed attempt leaves delivery at `queued` (not `sent_unacknowledged`) so the next `authorizeRelease`/`dispatchPending` cycle re-evaluates fresh eligibility rather than trusting the earlier attempt; `dispatchPending`'s in-process `sentThisProcess` short-circuit set was removed (it silently suppressed legitimate retries), replaced by the durable `delivery` state itself as the sole dedup signal. `fulfillment.recover` and `dispatchPending` both call the same `payments.authorizeRelease`.
- [x] Add crash tests before snapshot commit, after commit/before package prepare, after prepare/before send intent, after intent/before send, after send/before outcome, after acceptance/before ack. Wrong-buyer recovery/ack always fails. Reorg before first send holds; after acceptance flags `reorg_after_release` and cannot erase delivery history. Duplicate ack succeeds idempotently. Verified 2026-09-24: `PaymentHooks.crashBeforeCommit/crashAfterCommit` (pre-existing) cover before/after snapshot commit; `tests/unit/fulfillment.test.ts`'s crash-before-send/crash-after-send test now additionally asserts `getDisclosure` transitions (`none`→`attempted`→`transport-accepted`) across the intent/send/outcome boundary; wrong-buyer recovery/ack/status all still rejected (`buyer A vs B` tests); reorg-before-first-send (`disclose:false`) and reorg-after-release (`reorg_after_release` exception, delivery history preserved) both re-verified; duplicate ack with the same `packageId` is idempotent (new assertion in the rewritten acknowledge test), wrong `packageId` is rejected. Not separately added: an explicit "after prepare/before send intent" hook distinct from the existing before/after-send hooks, since `beginDeliveryAttempt` itself durably marks that exact boundary and is exercised by the same crash-before-send case.
- [x] Run all payment/fulfillment/store tests and typecheck. Delete or restrict test-only per-observation mutation APIs from the production assembly. Verified 2026-09-24: `npm test` — `payments.test.ts` 11/11, `fulfillment.test.ts` 11/11, `invoice-reduce.test.ts` 13/13, `issuance.test.ts` 7/7, `invoices.test.ts` 4/4 all GREEN; `npm run typecheck` clean. Production `payments.ts` no longer calls `store.commitReconciliation`/`store.getCheckpoint` (the old per-observation path) anywhere; those two `SellerStore` methods remain defined and covered by their own `tests/unit/invoices.test.ts` case but are dead code from production's perspective. Not done this pass: actually deleting `commitReconciliation`/`getCheckpoint`/`ReconciledCheckpoint`/`send_attempts` column from the `SellerStore` interface, schema and their dedicated test — left in place pending explicit user sign-off, since removing an interface method plus a passing, purpose-built test is a design decision, not a bug fix, and out of this pass's "don't spend too much time" instruction.

**Task 5 status (2026-09-24): functionally complete for `payments.ts`/`fulfillment.ts`'s own scope.** All snapshot-driven reduction, fresh-eligibility release gating, intent-before-send/outcome-after-send crash safety, and packageId-bound idempotent acknowledgement are implemented and GREEN. Two items intentionally left open, both flagged to the user rather than decided unilaterally:
1. `commitReconciliation`/`getCheckpoint`/`ReconciledCheckpoint`/`send_attempts` are unused by production code but still present in `SellerStore`/schema/tests — not deleted this pass.
2. `server.ts`'s public `/api/orders`, `/api/status`, `/api/recover` routes still issue invoices via the legacy `store.getOrCreateInvoice` memo path (Task 7's explicit scope to rewire), so `tests/unit/security.test.ts` has 4 failing cases that exercise those legacy routes against the now-correctly-non-payable legacy invoice type. This is an expected, disclosed consequence of Task 5 retiring automatic legacy-path settlement, not a Task 5 regression.

```ts
await fulfillment.dispatchPending();
await fulfillment.dispatchPending();
expect(memoryMessaging.sent).toHaveLength(1);
const recovered = await fulfillment.recover(invoice.orderId, invoice.buyerKeyId);
expect(recovered.encryptedEnvelope).toEqual(memoryMessaging.sent[0].encryptedEnvelope);
```

Here fulfillment uses the new authenticated-buyer entrypoint from Section 3.3, a ready deterministic snapshot and a real temporary store; memoryMessaging is only the fixture transport.

- [ ] Add crash tests before snapshot commit, after commit/before package prepare, after prepare/before send intent, after intent/before send, after send/before outcome, after acceptance/before ack. Wrong-buyer recovery/ack always fails. Reorg before first send holds; after acceptance flags `reorg_after_release` and cannot erase delivery history. Duplicate ack succeeds idempotently.
- [ ] Run all payment/fulfillment/store tests and typecheck. Delete or restrict test-only per-observation mutation APIs from the production assembly.

**Done:** Fresh health cannot refresh stale evidence; downtimes/reorgs cannot silently authorize unpaid first disclosure; restart/recovery preserves one immutable entitlement.

## Task 6: Promote Gate A to authenticated reusable Waku sessions

**Files:** Create `src/adapters/waku.ts`, `tests/unit/waku.test.ts`, `tests/integration/waku.test.ts`; modify `src/adapters/credentials.ts`, `messaging.ts`, `src/seller/identity.ts`; add `tests/unit/identity.test.ts`.

**Consumes:** Frozen wire union and credentials/session contracts. **Produces:** actual browser/Node `WakuSession`, public-key accessor, seller identity validation, delivery sender adapter.

- [x] Write round-trip tests using the real message-encryption codec: correct sender accepted; wrong/missing signer rejected; ciphertext tampering fails. **Verified 2026-09-24**: `tests/unit/waku.test.ts` (10 tests, using real `@waku/message-encryption/ecies` `createEncoder`/`createDecoder` over a fake-but-real-proto-shaped transport, not a custom cipher) — round trip, missing-signature rejection, failed-self-verification rejection, malformed-JSON rejection, `decodeStored` byte-mutation rejection. **Not yet covered**: "sender claim inside JSON ignored" and "altered network/seller/request body rejected" as dedicated Task-6-level tests — these properties are already enforced by `src/contracts/messages.ts`'s `encodeMessage`/`decodeMessage` validation (exercised in existing message-contract tests), not duplicated here.
- [x] Run `npx vitest run tests/unit/waku.test.ts tests/unit/identity.test.ts` to red. **Verified 2026-09-24**: both files authored before implementation; `identity.test.ts` failed 2/7 (mismatch + pin checks) and `waku.test.ts` failed 2/10 (round-trip wiring + assertion API misuse) before their respective fixes; both now 7/7 and 10/10 green.
- [x] Implement SDK lifecycle from `spikes/messaging/src/waku-session.js` in `src/adapters/waku.ts`: waits for peers via `waitForPeers`, subscribes its own decoder before use, resubscribes on a `waku:connection` reconnect event, bounds pending requests to 128, concurrent decodes to 16, and per-signer requests to 60/min (excess silently dropped, not queued). `send` retries up to 3 attempts with a configurable interval on zero-peer failures before throwing; node startup (`ensureStarted`) is wrapped in a `peerTimeoutMs`-bounded timeout that rejects instead of hanging forever. **Verified 2026-09-24**: `tests/unit/waku.test.ts` now 14/14, including bounded-retry-then-throw, retry-then-succeed, and startup-timeout tests, all RED-confirmed before the corresponding implementation.
- [x] Verify ECIES-decoded `signaturePublicKey` using the library's `verifySignature(expectedPublicKey)` self-check before accepting a message as coming from any signer (`verifiedSignerKeyId` in `src/adapters/waku.ts`); a message without both `signaturePublicKey` and a passing `verifySignature` call is dropped before reaching the subscriber's handler. **Verified 2026-09-24** via the two rejection tests in `waku.test.ts`.
- [x] Keep all sensitive fields inside encrypted payload; inspect real serialized envelopes for order/product/buyer/amount markers. **Verified 2026-09-24**: new test in `tests/unit/waku.test.ts` builds a real wire envelope via `toWireForTest` with a marked `orderId` and asserts the plaintext marker is absent from the serialized bytes (passed immediately — confirms already-correct encrypted-payload behavior rather than fixing a leak).
- [x] Implement publicKey accessor and credential-owned Waku session creation. `credentials.ts`'s `createWakuSession` now delegates to the real `src/adapters/waku.ts` implementation instead of throwing `not implemented`. Seller identity (`src/seller/identity.ts`) now validates the persisted private/public pair via the library on every load (`loadOrCreateSellerIdentity` throws `seller identity mismatch` on tamper), uses `wx`-flag exclusive file creation to avoid same-process double-create, and accepts an `expectedPublicKeyHex` pin that fails startup on mismatch. **Verified 2026-09-24**: `tests/unit/identity.test.ts`, 7/7 passing.
- [x] Run a separate `vitest.integration.config.ts` real Waku Node/browser exchange with explicit opt-in. **Verified 2026-09-24, genuinely live**: `tests/integration/waku.test.ts` connects two `createWakuSession` instances to the real js-waku public bootstrap fleet (default `defaultBootstrap`, no injected fake transport), sends a signed `status` request buyer→seller, and asserts the seller's `subscribe` handler receives it with a verified `signerKeyId` matching the buyer's real public key — i.e. an application-authenticated response, not merely a transport ack. Run three times via `npx vitest run --config vitest.integration.config.ts tests/integration/waku.test.ts`: passed in 13.4s, 13.0s, and 8.9s (realistic peer-discovery/dial/subscribe timing, not an instant false-pass or short-circuited skip). Missing-peer/strict-mode SKIP-vs-FAIL behavior (`SSF_STRICT_LIVE_WAKU=1`) is implemented per the plan but not itself exercised this session since real peers were reachable.

**Status (2026-09-24)**: Task 6 is now functionally complete against its own "Done" line — reusable real transport with verified sender and measured readiness, confirmed against the live network. Two plan-doc line items were intentionally scoped down: (a) "sender claim inside JSON ignored" / "altered network/seller/request body rejected" are enforced by the pre-existing `src/contracts/messages.ts` validators rather than duplicated in `waku.test.ts`, since that's where the plan's own Section 3/Task 2 already places that responsibility; (b) explicit payload-size capping beyond the existing `MAX_MESSAGE_BYTES` check in `encodeMessage` was not added as a separate Waku-layer limit, since it would be redundant with the contract-layer bound already enforced before every `send`. No application checkout was implemented by this task, consistent with the "Done" line.

**Done:** Reusable real transport with verified sender and measured readiness; no application checkout implemented by this task.

## Task 7: Wire seller business operations to Waku, not public HTTP

**Files:** Create `src/seller/messages.ts`, `tests/unit/seller-messages.test.ts`; modify `src/seller/server.ts` only for handler delegation and route restriction; extend `tests/unit/security.test.ts`.

**Status (2026-09-24, updated).** Fixed the root cause of the 4 previously-disclosed `security.test.ts` failures: `/api/orders` now issues invoices through `createInvoiceIssuer` (Task 4's receiver-attribution issuer) instead of the legacy `store.getOrCreateInvoice` memo path, with `chain`/`accountId` sourced from the scanner's own startup snapshot. Diagnosing that surfaced and fixed two real, previously-latent bugs: (1) `MemoryScanner.setHealth()` mutated snapshot content without bumping `generation`, tripping `commitSnapshot`'s real same-generation-immutability invariant; (2) the security test's own scanner fixtures set `revision: tip` on the paying receipt (1 confirmation, not 10) and never bound a receiver via `setReceiptReceiver` — fixed the fixtures, not the invariant. Then built `createSellerApplication` (`src/seller/messages.ts`, new) and its subscription dispatcher `attachSellerApplication`, with a new `tests/unit/seller-messages.test.ts` (13/13 GREEN, RED-confirmed for the tamper-detection case by temporarily disabling the check and observing the expected failure).

- [x] Test signed create/status/recover/ack, wrong-owner requests, changed-payload same messageId, expired/future request, wrong seller/network, and response-operation correlation. **Done 2026-09-24** in `tests/unit/seller-messages.test.ts` (13 tests): signed create bound to signer, duplicate-create replay returns the same durable invoice, changed-payload-under-same-messageId rejected (RED-confirmed), wrong-owner status/recover rejected `forbidden`, recover-then-acknowledge with exact packageId binding, expired/future/wrong-seller/wrong-network requests all rejected, every response's `inReplyTo` correlates to its request, plus two dispatcher tests (`attachSellerApplication`) covering Waku-decoded dispatch and response addressing, and ignoring looped-back `SellerResponse` bodies.
- [x] Implement operation dispatch after signature/body/time/size checks. **Done**: `createSellerApplication` in `src/seller/messages.ts` validates envelope (expiry, seller/network binding) before touching the durable inbox, calls `store.recordMessage` for dedup (pre-existing `db.ts` logic, confirmed sufficient without changes), and distinguishes a genuine duplicate (same digest, same messageId — returns the prior response's effect) from a tampered replay (same messageId, different digest — rejected as `invalid`). Duplicate create re-runs `issuer.issue`, which is itself idempotent per order/requestId (Task 4); duplicate recover re-runs `payments.authorizeRelease`, which is itself idempotent (Task 5, "replay" reason).
- [x] Respond encrypted only to the verified requester; no arbitrary reply URL/key accepted from JSON. **Done**: `handle()`'s only notion of "who asked" is the caller-supplied `signerKeyId` (the cryptographically verified Waku sender identity from Task 6's `WakuSession`, never a request-embedded field); every response is addressed to that same `signerKeyId` as `buyerKeyId`. Status/recover/acknowledge all load the invoice and compare `invoice.buyerKeyId === signerKeyId`, rejecting `forbidden` otherwise — verified by the wrong-owner test. Recovery calls the common `payments.authorizeRelease` path (same release-eligibility gate Task 5 built) and returns the sealed `packageId`+`package`; a bare order ID from an attacker is insufficient (the wrong-owner test proves this explicitly).
- [x] Disable `POST /api/orders`, `/api/status`, `/api/recover` in real-demo. Retain explicit fixture routes solely for existing deterministic browser tests. **Done 2026-09-24**: `src/seller/server.ts` returns 404 for these three routes when `config.mode === 'real-demo'`; fixture mode (used by all existing deterministic tests) is unaffected. New test `'real-demo mode disables direct HTTP checkout/status/recover routes'` in `tests/unit/security.test.ts`, RED-confirmed then GREEN.
- [x] Disable all payment override routes in every public mode. **Pre-existing, unchanged**: `/api/payment-override` and `/api/mark-paid` already return 404 unconditionally; covered by the existing security test.
- [ ] Not done: exercising response loss/reconnect/replay across an actual seller **process restart** (only in-process idempotency is tested); asserting no private keys/amount/receiver/body/wrapped-package appear in log output; readiness exposing no default-true messaging state. Also not done: wiring a live `WakuSession` + `attachSellerApplication` into `startSeller`/`server.ts` itself — the plan's own Task 7 spec says "sender/transport supplied externally by Task 10," so this is intentionally left for Task 10 to consume, not a Task 7 gap. Admin stays on its separate private listener: unchanged, already true.

**Deviation from the plan's literal `deps` list, noted per the standing "flag deviations" instruction**: `createSellerApplication`'s deps are `{ store, issuer, payments, sellerKeyId, network, now }` — `fulfillment` was dropped. `fulfillment.recover`/`.acknowledge`/`.status` all require a raw `credentialId` for HTTP-style possession-proof (`credentials.provePossession`/`verifyPossession`), which has no equivalent in a Waku message: the signer is already cryptographically verified by the transport layer (Task 6), so `messages.ts` does its own, simpler ownership check (`invoice.buyerKeyId === signerKeyId`) directly against `store`/`payments`, without re-deriving a possession proof. This is functionally equivalent security (ownership is still checked before any disclosure) but is a different code path from the HTTP fixture routes' credential-proof flow — the two are not (yet) unified into one ownership-check implementation, which is a note for future consolidation, not a known gap.

**Done:** Seller checkout/recovery uses real Waku handler composition; business rules have one owner and cannot be bypassed through HTTP. **Substantially met**: `createSellerApplication`/`attachSellerApplication` exist, are fully tested, and are transport-agnostic (HTTP or Waku can both call `handle`); the real-demo HTTP kill-switch prevents the direct-HTTP bypass in the mode that matters. Not yet met: actual live `WakuSession` wiring in `server.ts` (deferred to Task 10 per the plan's own text), and the restart/reconnect/replay and no-secrets-in-logs assertions remain unwritten.

## Task 8: Make Logos reads independently replica-backed

**Files:** Modify `src/adapters/storage.ts`, `src/seller/catalogue.ts`, `src/gateway/ciphertext.ts`; create `tests/unit/logos-storage.test.ts`; extend `tests/integration/storage.test.ts`, `tests/unit/gateway.test.ts`.

**Consumes:** Existing `StorageAdapter`; explicit `LogosRuntime` paths; published digest/size. **Produces:** same publish/fetch/verifyReplica surface, asynchronous checked CLI runner, product-specific readiness; no new storage provider.

**Status (2026-09-24).** Rewrote `src/adapters/storage.ts`'s Logos half around an injectable `LogosRunner` interface (`call`/`waitForEvent`), so unit tests can exactly script RPC results and completion events per config dir without spawning any process or standing up a live two-node runtime. `catalogue.ts` and `gateway/ciphertext.ts` were not modified — their public contract (`getPublishedCiphertext`, `verifyReplica` probe) already matched what the rewritten adapter provides, and `tests/unit/gateway.test.ts` (8 tests, pre-existing) continues to pass unchanged against the new adapter internals.

- [x] Write a process-call test: publish connects A→B, but fetching warmed CID after origin failure invokes ONLY B. Add partial-file, wrong-CID completion, wrong-size/digest, process failure, hung command and concurrent same-size publication cases. **Done 2026-09-24** in `tests/unit/logos-storage.test.ts` (10 tests, all RED-confirmed against the pre-rewrite adapter — the whole file failed to typecheck since `LogosRunner` didn't exist, then 3 further runtime failures after the interface was added but before the implementation matched it): origin/replica addressing separation, wrong-CID-in-completion-event rejection, `success:false` rejection (not read as partial), filename-mismatch-on-upload-completion rejection, hung-watch timeout (no event ever arrives) rejection, process failure surfacing as a real error message, oversize-download rejection, two genuinely concurrent same-size publications each correlating to their own event (not a size-matched fallback), and `detectLogosRuntime` requiring explicit env config with no hardcoded worktree/scratch path candidates (asserted directly against the adapter source, not just behavior).
- [x] Run `npx vitest run tests/unit/logos-storage.test.ts tests/unit/gateway.test.ts` to red. **Done**: `logos-storage.test.ts` was RED (module didn't export `LogosRunner`, typecheck failed); `gateway.test.ts` was already GREEN pre-rewrite and stayed GREEN post-rewrite (it exercises `createCiphertextHandler` against an injected `getPublishedCiphertext`, decoupled from the storage adapter internals entirely).
- [x] Move origin peer discovery/connect to publication/replication setup. `fetch` and `verifyReplica` address B directly, with no origin health prerequisite. Remove hardcoded historical worktree/scratch path candidates; explicitly configured runtime only. **Done**: `establishReplication()` (origin `peerId` + replica `connect`) now runs only inside `publish()`, after the upload completes; `fetch`/`verifyReplica` call `downloadAndWait` directly, touching only `runtime.replicaConfigDir` — verified by the "invokes only the replica" and "touches only the replica, never the origin" tests. `detectLogosRuntime` now reads only `LOGOSCTL`/`LOGOS_NODE_A`/`LOGOS_NODE_B`; the hardcoded `.worktrees/feat-mvp-t2`/`appimage_extracted_` candidate paths are gone (asserted by grepping the adapter source in the new test, not just behavior).
- [x] Replace synchronous CLI work on request paths with `spawn` promises, bounded output/deadlines and finally cleanup. Use per-operation unique files; correlate exact returned CID/file/event; no first-new-manifest-of-same-size fallback. Read completed file only after successful operation completion and published size/digest verification. Reject partial/overlarge content. **Done**: `waitForEvent` uses `spawn` (not `spawnSync`) with an explicit `setTimeout`-bounded promise that resolves `null` on timeout (never hangs, never false-completes) and always kills the watcher process in its `finish()` path. Per-operation files use `randomUUID()`, not a timestamp (two calls in the same millisecond no longer collide). Correlation is by the event body's own `cid`/`filename` fields, compared with strict equality against what the operation itself requested — there is no manifest-listing/same-size fallback at all anymore (the old `listManifests`/`before`-set/first-new-of-same-size logic is gone). Concurrent same-config-dir operations are serialized via a per-config-dir lock (`createQueue`/`withLock`) specifically so two overlapping requests' watch output can never be cross-attributed. Oversize downloaded content is rejected via `maxBytes` before being returned.
- [x] Complete publication only after bytes retrieved from B equal ciphertext digest/size. Store replica verification per immutable version; expose readiness for requested product, not the catalogue's first row. **Unchanged, already true**: `src/seller/admin.ts`'s `publishProduct` already calls `storage.verifyReplica(cid, replicaId)` (an actual round-trip download+compare through the now-rewritten adapter) before `catalogue.completePublication` commits the row; `catalogue.getPublishedCiphertext` already re-verifies `sha256Hex(body) === row.ciphertext_digest` on every read regardless of adapter claims (`src/seller/catalogue.ts:142-148`, not modified). `currentAvailability()`'s default `storageReplica` probe already checks the specific published product's own CID (`src/seller/catalogue.ts:126-132`), not an arbitrary first row — this was already correct before this task and did not need a code change, only verification that it still holds against the rewritten adapter (confirmed: `gateway.test.ts`'s "unpublished product" and "valid published identifier" tests still pass through the same probe path).
- [ ] Not done: the real two-node test itself (fresh 41-byte payload, independent peer IDs/data dirs, stop-origin-then-fetch-from-B, 42-byte rejection, tampered-ciphertext rejection). `tests/integration/storage.test.ts`'s existing opt-in live test was updated only for the new `createLogosStorageAdapter(runtime, { workDir })` deps-object signature (was a bare string positional arg) and re-confirmed it still correctly **skips** (`ctx.skip()`) when `detectLogosRuntime()` finds no live runtime configured in this environment — it was not run against a real live two-node Logos runtime this session, since none is available here. This is a genuine gap, not silently claimed done.

**Done:** Origin-stop retrieval requires no live origin or application cache; storage CLI cannot block Waku/scanner event loops. **Substantially met at the unit level**: `fetch`/`verifyReplica` provably never address origin (tested), CLI calls are async/bounded (no more `spawnSync` on the watch path), and there is no origin-health prerequisite anywhere in the read path. **Not yet verified against a real two-node runtime** — the live "stop origin, fetch from B" scenario remains unexercised in this environment; `npm test`, `npm run typecheck`, `npm run build`, `git diff --check` all clean (200/200 unit tests, up from 190/190).

## Task 9: Connect the actual browser controls and generate real payment QR

**Files:** Create `src/browser/waku-transport.ts`, `src/browser/payment-request.ts`, `tests/unit/payment-request.test.ts`; modify `src/browser/{app,checkout,purchases,download}.ts`; extend `tests/browser/{purchase,recovery,privacy}.spec.ts`; create `tests/browser/qr.spec.ts`.

**Consumes:** `WakuSession`, verified seller public configuration, `OrderTransport`, library-generated paymentUri and versioned purchase records. **Produces:** `createWakuOrderTransport(credentials: CredentialAdapter, session: WakuSession, sellerConfig: { sellerKeyId: string; network: Network; amountZat: string; productVersion: string }, purchases: PurchaseStore): OrderTransport`, wired visible flow and local QR renderer using selected package. Each session is scoped to its purchase credential; reopening My purchases restores the matching credential/session rather than reusing another purchase's key.

**Status (2026-09-24).** `createWakuOrderTransport` is now built and verified end to end against a real signed Waku round trip (not a mock). The QR sub-scope (below) was completed first as a smaller increment; this update adds the transport itself.

- [x] Replace `qrMarkup` static SVG with local QR encoder output. Test by decoding rendered pixels using the selected decoder and comparing exact library-generated URI. Test long valid UA, exact integer→decimal amount and no required memo. URI display/copy/open all share identical bytes. **Done**: new `src/browser/payment-request.ts` (`buildQrMatrix`/`qrSvgMarkup`) builds the exact module matrix `qrcode` computes for the URI and emits it as real per-module `<rect>` SVG primitives (not a fixed decorative placeholder). `qrMarkup` in `app.ts` now calls `qrSvgMarkup(uri)` directly. New `tests/unit/payment-request.test.ts` (5 tests) rasterizes the *actual emitted SVG markup* (parsing its own `<rect>` tags, not re-deriving pixels from the matrix) into an RGBA bitmap and decodes it with `jsQR`, asserting the decoded string is byte-identical to the library-generated URI for the full-length shielded testnet address, confirms two different valid invoices decode to two different strings (ruling out a static placeholder), confirms the finder-pattern structure of the raw matrix itself, and confirms an empty payload is rejected rather than silently rendering a blank/placeholder image. `#zip321-uri`/`#open-uri`/`#copy-uri`/the QR's own `data-zip321-uri` attribute all already shared one `uri` value from before this change (verified unchanged by the pre-existing `tests/browser/purchase.spec.ts` "renders the exact ZIP-321 URI..." test, still green).
- [x] Build `src/browser/waku-transport.ts` / `createWakuOrderTransport`. **Done**: `createWakuOrderTransport(credentials, session, sellerConfig, purchases)` implements `OrderTransport` (`create`/`status`/`recover`/`acknowledge`) entirely over an already-open `WakuSession`. Each call sends a signed `BuyerRequest`, subscribes once (lazily, before the first send so a fast reply is never missed), correlates the response via `messageId`/`inReplyTo`, verifies the response is signed by the configured `sellerKeyId` and addressed to the calling credential's own `buyerKeyId` (rejecting otherwise), retries up to 3 times with a *fresh* `messageId` per attempt on a lost response (never replays the exact same envelope — a genuine resend would dedup as a no-op at the seller's inbox if the original request actually arrived and only the reply was lost), and persists the recovered package's original signed wire envelope via `purchases.saveDelivery` before returning it, so a later reload can re-verify the retained signature/bindings rather than trusting a decrypted-only cache. New `tests/unit/waku-transport.test.ts` (4 tests) wires this against the *real* `createWakuSession`/`attachSellerApplication`/`createSellerApplication` stack (not stubs) over the same fake in-memory `WakuNode` transport double used by `tests/unit/waku.test.ts` — so every message genuinely round-trips through real ECIES encode/sign/decrypt/verify, not a mocked call. Covers: full create→status→pay→status→recover→acknowledge lifecycle with real confirmation-threshold state transitions; a non-owning credential's `recover` being rejected; a lost seller response being retried with a fresh `messageId` and the call still completing (verified by intercepting the second `lightPush.send` and dropping its delivery); and a seller `error` response (unpublished product) surfacing as a rejected promise. This work also surfaced and fixed one genuine bug in Task 7's `createSellerApplication`: its `status` case case never called `payments.reconcileFromScanner()` before reading order status, unlike `server.ts`'s pre-existing HTTP `/api/status` handler — so a Waku status check right after a payment landed would report stale `'awaiting'` state instead of triggering reconciliation. Fixed by adding the same `reconcileFromScanner()` call `messages.ts`'s `status` case that `server.ts` already had.
- [ ] Not yet done: wiring `createWakuOrderTransport` into `app.ts`'s `createBrowserTransport` (or an equivalent selection point) so the user-visible flow actually uses it instead of `/api/orders` HTTP calls in real-demo mode. The transport itself is a complete, independently-tested building block; nothing in `app.ts` constructs a `WakuSession` or calls `createWakuOrderTransport` yet.
- [ ] Not done: real Playwright acceptance tests using `getByRole`/real controls with no injected `window.__ssf` hooks, wrong-seller/buyer/amount/product/network/inReplyTo negative cases over Waku, pending-request correlation/bounded retries/subscription-before-request, unsolicited-delivery acceptance rules, purchase backup/IndexedDB migration versioning, and the updated privacy test restricting to configured Waku peers only (HTTP purchase routes currently remain reachable and are exercised directly by `tests/browser/purchase.spec.ts`, which stays HTTP-based by design until `app.ts` is wired to the Waku transport).
- [x] Run `npm run test:browser`, `npm test`, typecheck and clean build. **Done**: `npx playwright test tests/browser/purchase.spec.ts tests/browser/recovery.spec.ts tests/browser/privacy.spec.ts` — 28/28 pass. `npm test` — 209/209 unit tests pass (up from 200/200: +5 `payment-request.test.ts`, +4 `waku-transport.test.ts`). `npm run typecheck`, `npm run build`, `git diff --check` all clean.

**Regressions found and fixed while making this real** (both were latent since Task 7's issuer rewrite, only surfaced once a real end-to-end Buy click was exercised against the real issuer instead of a stale assertion):
1. `startSeller`'s built-in `MemoryScanner` default construction left `chain.network` hardcoded to `'regtest'` regardless of `config.productNetwork` (commonly `'test'` in fixture-mode tests/specs). Since Task 7 wired `/api/orders` to derive `chain` from the scanner's own snapshot rather than `config.productNetwork` directly, every fixture-mode order created through the real HTTP path failed `assertInvoiceBinding`'s `invoice.network !== 'test'` check. **Fixed** by adding `MemoryScanner.setChainNetwork()` and calling it in `startSeller` (for both the default scanner and any injected `MemoryScanner`) before any snapshot is taken.
2. `src/browser/checkout.ts`'s `assertInvoiceBinding` required `invoice.attributionRef` unconditionally, but that field is documented in `contracts/types.ts` as a read-only compatibility field for legacy memo-attributed invoices only — Task 7's real receiver-attributed invoices never set it. Every real invoice from the actual issuer was rejected client-side as "incomplete terms." **Fixed** by accepting either a real `attribution.kind === 'receiver'` binding or the legacy `attributionRef`, not requiring the legacy-only field unconditionally.

Also updated two stale test assertions written against the pre-Task-7 memo-invoice/destination-reuse model: `tests/browser/purchase.spec.ts`'s "Buy click..." test asserted the rendered URI contained the config-level `SSF_DESTINATION`, which the plan itself documents as no longer used for live unique-receiver invoices (Task 10 notes); changed to assert a `zcash:uregtest1...` unique-receiver URI shape instead. Its "recover returns the delivery package..." test built a scanner fixture using the pre-Task-5 `invoiceId`-injection pattern (no `setReceiptReceiver`) and a mined-height-equals-tip-height fixture (1 confirmation, not the required 10) — both classes of bug already diagnosed and fixed in `security.test.ts` earlier this session; applied the same fix here.

**Done:** QR is decodable, not decorative (verified by a real jsQR decode of the actual rendered markup). `createWakuOrderTransport` is built and verified against a genuine signed Waku round trip. **Not yet done:** the user-visible browser flow (`app.ts`'s `createBrowserTransport`) is not wired to `createWakuOrderTransport` — it still runs over `/api/orders` HTTP; Waku-specific Playwright acceptance tests also remain to be written. Public wallet interoperability still belongs to T.

## Task 10: Assemble the built live runtime and startup gates

Infrastructure available: npm run infra:up; consume .runtime/live/live.env (see docs/live-infra.md).

**Files:** Create `src/adapters/live.ts`, `src/runtime.ts`, `tests/unit/live-composition.test.ts`, `scripts/start-live.ts`, `docs/live-runtime-config.md`; modify `src/main.ts`, `src/config.ts`, `src/seller/server.ts`, `src/ops/log.ts`, `package.json` and CSP handling.

**Consumes:** Completed tracks. **Produces:** `createLiveAdapters(config)` returning scanner/storage/Waku dependencies, `startRuntime(config)` owning lifecycle, `npm run start:live`. Fixture factory is separate and unreachable from real-demo composition.

- [ ] Write a composition test that rejects any absent adapter and rejects mismatched actual adapter implementation identity despite `SSF_ADAPTER_*=real`. Test startup failure unwinds already-started components in reverse order.

```ts
await expect(startRuntime(invalidLiveConfig)).rejects.toThrow();
expect(stopped).toEqual(['waku', 'scanner']);
expect(fixtureFactoryCalls).toBe(0);
```

Use test-local factories passed to the runtime constructor; no production mutable globals.

- [ ] Run `npx vitest run tests/unit/live-composition.test.ts tests/unit/config.test.ts tests/unit/availability.test.ts` to red.
- [ ] Implement explicit live configuration: `SSF_MODE=real-demo`, `SSF_NETWORK=regtest|test`, `SSF_SCANNER_SOCKET`, `SSF_SCANNER_ACCOUNT_ID`, chain/genesis/activation identity (the activation schedule is configured, and `consensusFingerprint` is always derived with `src/contracts/consensus.ts` per Section 3.1b; a raw digest setting is rejected), `SSF_WAKU_CONTENT_TOPIC`, configured WebSocket bootstrap peers, `LOGOSCTL`, `LOGOS_NODE_A`, `LOGOS_NODE_B`, data paths and existing size/confirmation/TTL limits. Secret-bearing admin/scanner config comes from protected files; never embed it in browser config. `SSF_DESTINATION` is not required or used for live unique-receiver invoices.
- [ ] Use validated persisted seller identity in every component and public metadata; pin validation failure is fatal. Construct issuer/application/fulfillment and subscribe actual Waku handler before accepting new checkout. Probe scanner snapshot freshness and product replica, not config booleans. No seeded fixture product in live mode.
- [ ] Start bounded non-overlapping scanner reconciliation and dispatch loops with sanitized errors/backoff. Display verification unavailable on outage rather than swallowing `.catch(() => undefined)`. New checkout readiness is per product; issued invoice replay and durable accepted recovery remain available as specified.
- [ ] Serve explicit `dist/browser`, no working-directory fallback in live mode. CSP uses the specific configured `wss:` peers (local `ws:` only for explicitly local setup), not `connect-src *`. Log only event class/status/timing and safe aggregate counters.
- [ ] Add SIGINT/SIGTERM and partial-start shutdown for subscriptions, peer clients, timers, scanner adapter, servers and stores. Startup script prints URLs/ready states only; stops only resources it owns. Provide a private admin publication command/runbook path using the existing API, not a hardcoded product fixture.
- [ ] Run clean build then launch `dist/service/main.js` in an integration subprocess with real adapters and bounded readiness wait. Read back exact readiness and `/api/product` identity; verify disabled HTTP routes. Stop/restart and check no leaked process/port.

**Done:** The compiled entrypoint actually runs the live stack; source tests or isolated spikes are insufficient.

## Task 11: Preserve recovery through coordinated backup/restore

**Files:** Modify `src/seller/backup.ts`, `scripts/backup-check.ts`; create `scripts/backup-live.ts`, `tests/unit/live-backup.test.ts`; extend scanner `tests/restore.rs`; update `docs/runbook.md`.

**Consumes:** Seller DB/product keys/identity; scanner wallet/allocation state/UFVK/birthday/config. **Produces:** encrypted version-2 coordinated backup and restore checker, retaining v1 seller-only restore with explicit limitations.

- [ ] Write tests showing seller-only backup lacks allocation state and must NOT be described as complete live restore. Test corrupted/wrong-key archives, mismatched account/chain, identity preservation and output permissions.
- [ ] Run `npx vitest run tests/unit/live-backup.test.ts` to red.
- [ ] Implement initial backup only with both services stopped and exclusive file access verified; checkpoint SQLite WAL before snapshotting. Reuse existing authenticated encryption, protected backup key file, versioned manifest and checksums. Include UFVK/allocations only inside encrypted archive; exclude all spending material. No archive path traversal/overwrite on restore.
- [ ] Restore into fresh 0700 directories, validate files and identity, reset freshness, establish a new explicitly acknowledged scanner source epoch if generation cannot be preserved, rescan before first release, and reconcile all outstanding allocation mappings. Never lower the reserved-address high-water mark or reissue a lost allocation.

```ts
expect(restored.identityPublicKeyHex).toBe(original.identityPublicKeyHex);
expect(restoredInvoice).toEqual(originalInvoice);
if (originalInvoice.attribution.kind !== 'receiver') throw new Error('receiver fixture required');
expect(nextAllocation.receiver.receiverHex)
  .not.toBe(originalInvoice.attribution.receiver.receiverHex);
expect(priorReceiverHexes).not.toContain(nextAllocation.receiver.receiverHex);
```

`priorReceiverHexes` is read from every pre-backup allocation, including burned/unissued reservations. Compare receiver bytes rather than the destination UA string.

- [ ] Prove recovery of an accepted package without new payment, and discovery/reconciliation of a payment received while seller was offline. Stop/restart tests do not destroy the test payer environment.
- [ ] Run `npm run backup-check` plus coordinated live restore check, scanner restore tests and browser backup-import regression. Reports contain no archive plaintext or credentials.

**Done:** Merchant recovery covers scanner allocation authority as well as seller data; no duplicate receiver or new entitlement after restore.

## Task 12: Run strict built-app acceptance and report only observed results

**Files:** Modify `scripts/demo-check.ts`, `tests/unit/demo-check.test.ts`, `docs/demo-results.md`, `docs/integration-report.md`, `docs/runbook.md`; create `playwright.live.config.ts`, `tests/live/storefront.spec.ts`, `scripts/live-resources.ts`; update package scripts.

**Consumes:** Built runtime, real local chain, owned origin/replica, qualified scanner, real Waku peers. **Produces:** `npm run demo:live`, strict L report and separate T status. `demo:live` invokes clean build, starts owned resources, runs the live browser suite serially, writes evidence and exits nonzero unless every L row passes.

- [ ] Write report-validator tests before changing the harness. Unsupported/unavailable/fixture/skip can never produce overall live success; every required stage and concrete adapter/version identity is mandatory.

```ts
expect(validateLiveReport({ ...passingReport, liveAttempted: false }).ok).toBe(false);
expect(validateLiveReport({ ...passingReport, scanner: { kind: 'fixture' } }).ok).toBe(false);
expect(validateLiveReport({ ...passingReport,
  stages: passingReport.stages.filter(stage => stage.id !== 'origin-stop') }).ok).toBe(false);
```

`validateLiveReport(value: unknown): { ok: boolean; errors: string[] }` is created in `scripts/demo-check.ts` or a focused sibling imported by it; `passingReport` is an explicitly synthetic unit fixture containing ALL matrix rows. Never publish it as run evidence.

- [ ] Run `npx vitest run tests/unit/demo-check.test.ts` to red. Then implement resource ownership and strict report validation. Top-level runtime must expose actual adapter type/version and build provenance; flags alone are not evidence.
- [ ] Run `npm test && npm run typecheck && npm run build:clean && npm run test:browser`; run Rust fmt/check/clippy/test. Run optional integration tests separately and record skips instead of adding them to pass counts.
- [ ] L workflow: publish new random <=41-byte product → prove B retrieval → browser Buy creates two equal-price invoices → fund only A through separate payer → independently scan A → prove no key below ten confirmations → reach threshold → interrupt seller/browser before application delivery → restart → Waku recovery of same invoice/package → verify B copy → stop origin → restart gateway to remove process cache → fresh context imports purchase backup → Waku recover → B ciphertext fetch → browser decrypt/hash equality → signed ack. B's unpaid invoice stays locked throughout.
- [ ] Also demonstrate normal uninterrupted delivery and reconnect after response loss. For origin-stop, record failed origin health, B peer identity, new CID and request path reaching B. Do not use pre-existing CID, fixture bytes, server's upload buffer or browser cache. Retain exact created resource IDs and never stop unrelated nodes.
- [ ] Collect browser network events proving no live HTTP purchase route, authenticated application response evidence without leaking plaintext invoices, scanner source/generation/tip evidence, resource/version identities, redacted logs, plaintext/ciphertext equality booleans and timings. Keep raw sensitive traces private; sanitize before report.
- [ ] T workflow, only when a supported public-testnet wallet/endpoint is available: provision/import seller viewing account, run the SAME scanner and app on `network=test`, pay generated QR/URI from the external wallet, verify amount/receiver/confirmations and download. Record wallet/version, node/lightwalletd/protocol qualification. If unavailable today, mark T NOT RUN with reason; never translate L into testnet/mainnet readiness.
- [ ] Update runbook with exact successful setup/pin/start/publish/pay/mine/recover/stop commands and limitations from execution. Update the original design/decision status only to reflect what actually ran, preserving historical reports. Run `git diff --check` and read back the generated report target before claiming success.

**Done:** All L acceptance rows PASS from one source-linked built-app run (or honest FAIL/SKIP report). T is separately passed or explicitly unverified. No fake fallback and no production claim.

## 4. Acceptance matrix

| ID | Requirement | Primary task | Evidence / gate |
| --- | --- | --- | --- |
| L01 | Clean current-source built runtime; no memory substitution | 0, 10, 12 | Provenance + actual adapter identities |
| L02 | Qualified single-family wallet dependency/RPC graph and pinned read-only Rust schema boundary | 1, 3 | Locked cargo metadata + real protocol probe + migrated-schema/drift tests + projection compatibility report |
| L03 | Two equal-price invoices, only paid receiver credited | 1, 4, 12 | Receiver-owned notes + B remains locked |
| L04 | Idempotent immutable invoice/allocation after crashes | 2, 3, 4 | Seller/scanner restart tests of ALL terms |
| L05 | No release below ten confirmations | 5, 12 | Live below/at threshold evidence |
| L06 | Lower-height fork, same-height fork, missing receipt, stale/future health | 3, 5 | Real wallet-reader rewind/reopen fixtures + retained revoked identity; deterministic fault tests labelled as such |
| L07 | Coherent snapshot/atomic checkpoint/restart replay | 2, 3, 5 | Crash-boundary database tests |
| L08 | Under/over/duplicate/late/change/foreign-account policies; spent receipt retention and external receiver binding | 3, 5 | Permutation-invariant reducer + real SQL projection fixtures for spent/internal/sent/foreign/missing receiver rows |
| L09 | Waku create/status/delivery/recover/ack authenticated both ways | 6, 7, 9, 12 | Actual browser/seller Waku exchange |
| L10 | No HTTP fallback, sensitive routing or private backup export in normal flow | 6, 7, 9 | Negative network/security tests |
| L11 | Seller restart, browser reopen and portable recovery without repaying | 5, 9, 12 | DOM-controlled live recovery + immutable package |
| L12 | Replica-only NEW-CID retrieval after origin stop and gateway restart | 8, 12 | Origin failure + B retrieval + fresh browser decryption |
| L13 | Genuine ZIP-321 QR/URI; correct local network labels | 4, 9 | Rust URI round-trip + image QR decode |
| L14 | Fresh product-specific readiness; paid state survives delivery failure | 5, 8, 10 | Dependency outage/retry tests |
| L15 | Secret isolation, spending-free scanner, safe coordinated restore | 0, 3, 11 | Permissions, negative API tests, encrypted restore |
| L16 | Exact decrypted bytes; 41/73 cap; corruption rejected | 8, 9, 12 | Browser equality/integrity and boundary tests |
| T01 | Public-testnet external-wallet payment using same scanner/app | 12 | Separate live wallet handoff + confirmed receipt |

L01–L16 are all required for a verified local MVP claim. T01 is required for public-testnet qualification, not inferred from L. Mainnet, public Logos deployment and larger downloads remain unqualified.

## 5. Plan review and handoff

Before implementation, read the design and this plan together. No additional attribution decision is needed: the user delegated the choice, and the selected approach is unique receiver + repository-recommended view-only wallet stack. Task 1 may invalidate a candidate version; it cannot silently weaken the architecture or replace receiver evidence with payer data.

Reviewer checklist:

- Every spec section maps to the matrix/task owners above.
- One source/generation contract across Rust/TS; no lower-height discard; no stale-health-only release.
- One immutable invoice allocation across two databases; no new address on retry or lost-response retry.
- One authenticated Waku service path and one disclosure/recovery gate; no business-rule fork in HTTP.
- Origin-independent reads prove actual replica bytes for a current-run CID.
- Test commands distinguish unit, browser, live and public-network evidence.
- No wallet-library API claimed implemented before compilation; no same-day guarantee before the scanner gate.
- Read-only Rust wallet projection permission is copied into execution briefs; no application wallet-table writes or TypeScript wallet SQL. Production history does not depend on `WalletTest`, a known payer txid, or unspent-only queries.
- The projection is tested against the exact migrated wallet schema; spent/revoked history survives restart and unresolved receiver/schema/enhancement data cannot publish complete/ready.

Recommended execution: parallel workers after the serial contract boundary, with one integration owner and spec/security review between completed tasks. No automatic commits/pushes. For a fresh execution, start at Task 0 and run Task 1 before fanning out the implementation tracks.

### Resuming the existing Task 3 execution

The existing worktree is `.worktrees/live-mvp-integration` on `feat/live-mvp-integration`; recheck Git and `.superpowers/sdd/2026-09-23-live-mvp-integration/progress.md` before resumption. Its ledger records Tasks 0–2 complete and Task 3 incomplete; this plan repair does not rerun or independently recertify those earlier results. Preserve uncommitted implementation and historical evidence. Keep the base/execution plan copies and Task 3 brief synchronized; append a correction to the historical no-wallet-SQL blocker rather than deleting its actual probe result.

The former blanket SQL prohibition is superseded by the explicit boundary above. The API limitation remains true, but does not require a new dependency or architectural exception. On separately requested implementation, resume Task 3's missing projection, daemon, allocator finalization, enhancement and live adapter proof with RED→GREEN and review; do not restart completed tasks automatically or mark Task 3 complete from this documentation change. Tasks 4/5 and overall live release remain gated; Tasks 6/8 can be separately assigned within frozen contracts. This repair is documentation-only, not authorization to launch services, send payments, commit, push or modify upstream repositories.

**Consensus-fingerprint blocker (resolved 2026-09-24).** The owned live-proof preflight stopped because `chain.consensusFingerprint` had no canonical encoding. Section 3.1b now freezes v1, and the scanner enforces it: config derivation/binding plus a per-cycle lightwalletd Sapling/branch check. Shared Rust/TypeScript vectors pass. Resume Task 3 with the new provisioner step, then run the owned `init-view` → `serve` → TypeScript adapter proof against a freshly started instance. Task 3 is still incomplete, and no live claim follows from the fix itself.
