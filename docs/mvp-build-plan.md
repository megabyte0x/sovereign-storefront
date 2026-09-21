# Sovereign Storefront MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demonstrate a real shielded testnet purchase with encrypted Logos delivery, automatic browser recovery, and seller-restart/storage-node-failure recovery.

**Architecture:** A browser client talks to a single seller's service over encrypted Logos messaging. A read-only Zcash scanner authorizes durable fulfillment; a restricted HTTPS gateway serves ciphertext fetched through Logos Storage. Payment and delivery states remain independent. Initial key disclosure uses one shared release-authorization operation for dispatch and recovery.

**Tech Stack:** Proposed TypeScript browser/service application, Vite for the browser, Node for the service, SQLite for seller persistence, IndexedDB for browser persistence, Vitest for deterministic tests, Playwright for browser tests. Native Logos adapters and the Zcash scanner are chosen and pinned only after integration probes. React is optional, not required for the four-screen MVP. No dependency is installed yet.

**Spec:** [mvp-design.md](mvp-design.md), approved by the user.

## Global constraints

- Browser-first purchase experience.
- One seller per deployment; one-time digital downloads; fixed ZEC prices; Zcash testnet only.
- No spending keys in checkout or fulfillment services.
- No bridge, wrapped ZEC, LEZ payment token, or custom blockchain.
- No account/email requirement; automatic same-browser recovery with optional portable backup.
- No third-party scripts or analytics on checkout and purchase pages.
- No transparent fallback. No zero-confirmation release in the MVP.
- An order ID alone never grants access. Valid authentication of buyer A is not authorization for buyer B's order.
- Never match payments solely by amount. Never automatically aggregate partial or unrelated payments into one fulfillment.
- Never represent mocks, fixtures or client assertions as real settlement or real Logos integration.
- No marketplace, multi-tenant hosting, subscriptions, escrow, fiat conversion, automatic refunds, physical goods or DRM.
- Public routing topics and envelope metadata must not contain order IDs, buyer identities or product names.
- Operational logs are allowlisted: no plaintext invoices, payment URIs, memo/attribution contents, destinations, buyer credentials or private keys.
- Each distinct purchase gets a fresh application credential; retries of the same purchase reuse that credential and request ID.
- Do not commit, push, install global tooling or deploy publicly without separate authorization. Suggested commit boundaries are review boundaries only until authorized.
- All new project files live inside this folder. It is its own Git repository; do not modify the parent money-research application or reuse its package manifest.

## Readiness and scope of this plan

At planning time the project contains research/design Markdown, not application code or a package manifest. The local terminal reports Node v26.9.0, npm 11.19.1 and rustc 1.98.0; these are observations, not selected production requirements.

This plan deliberately has a hard checkpoint after Tasks 1–3. Their deliverables are executed probes, pinned dependencies and actual upstream API mappings. Subsequent tasks specify our own application contracts, paths and acceptance behavior. They must be reconciled with the probe results before execution. Inventing upstream methods to make this document look immediately executable would be less useful than preserving that gate.

The commands below are commands to create/run during execution, not commands already run. Tests shown use proposed application APIs defined here; these are not claims about Logos or Zcash SDK exports.

## File ownership and proposed layout

```text
.gitignore                           runtime secrets/state, dependencies, test output (Task 0)
package.json                         project-local scripts and pinned dependencies
package-lock.json                    reproducible dependency resolution
tsconfig.json                        browser/service type checking
vite.config.ts                       browser build and dev configuration
vitest.config.ts                     deterministic test selection
playwright.config.ts                 browser suite, isolated test origins
spikes/messaging/                    Gate A browser/seller probe and local manifest
spikes/storage/                      Gate B two-node storage/browser probe
spikes/payments/                     Gate C wallet/scanner probe
spikes/results/                      sanitized evidence only
src/contracts/                       internal types and runtime wire validation
src/seller/catalogue.ts              immutable products and private publication
src/seller/orders.ts                 durable order/idempotency operations
src/seller/invoices.ts               durable invoice issuance and attribution
src/seller/payments.ts               observation ingest, invoice reducer, eligibility
src/seller/fulfillment.ts            shared release authorization and outbox worker
src/seller/db.ts                     SQLite transactions and migrations
src/seller/schema.sql                persistence constraints for all seller tables
src/seller/server.ts                 public catalogue/ciphertext, not admin APIs
src/seller/admin.ts                  local CLI for publish/status/backup
src/adapters/messaging.ts            verified Logos adapter
src/adapters/storage.ts              verified Logos adapter
src/adapters/scanner.ts              verified Zcash adapter
src/adapters/crypto.ts               product encryption and delivery sealing
src/adapters/credentials.ts          purchase-credential create/prove/export
src/browser/purchases.ts             IndexedDB records and backup handling
src/browser/checkout.ts              persistence-before-payment orchestration
src/browser/app.ts                   four-screen routing and rendering
src/browser/download.ts              verified local decryption and attachment save
src/gateway/ciphertext.ts            bounded ciphertext-only handler
src/config.ts                        testnet/real-adapter/config validation
src/main.ts                          service entrypoint
index.html                           self-hosted browser entrypoint
public/                              local assets only
scripts/demo-check.ts                real integration preflight
scripts/backup-check.ts              encrypted seller-backup restore exercise
tests/unit/                          deterministic state/contract tests
tests/browser/                       browser behavior tests
tests/integration/                   real-adapter suites, explicit environment gate
tests/fixtures/                      public synthetic fixtures only
README.md                            retain research; add setup navigation
docs/integration-report.md           actual versions, commands, gate outcomes
docs/runbook.md                      setup, safe operation, recovery and demo
docs/demo-results.md                 actual observed results and limitations
```

Do not scaffold empty modules merely to match this tree. Add each file in the task that first exercises it. Native scanner/Logos probe source files are named in their gate reports once the actual language/runtime is known.

## Shared application contracts

Task 4 creates these internal interfaces. The adapters translate upstream APIs into them; upstream SDK methods must be discovered, not presumed.

```ts
export type PaymentState =
  | 'awaiting' | 'detected' | 'confirming' | 'confirmed'
  | 'review_required' | 'reorged';
export type DeliveryState =
  | 'locked' | 'prepared' | 'queued'
  | 'sent_unacknowledged' | 'acknowledged' | 'retry_required';
export type ReviewReason =
  | 'underpayment' | 'overpayment' | 'late' | 'unmatched' | 'duplicate';
export type ExceptionCode =
  | ReviewReason | 'reorg_after_release' | 'delivery_failed' | 'verification_unavailable';
export type Verification = 'available' | 'unavailable' | 'stale';

export type ChainRevision = { id: string; height: number };
export type ScanCheckpoint = { revision: ChainRevision };

export type Invoice = {
  id: string; orderId: string; productVersion: string;
  buyerKeyId: string; network: 'test'; amountZat: string;
  destination: string; attributionRef: string;
  expiresAt: number;
};
export type Observation = {
  outputId: string; invoiceId: string | null; amountZat: string;
  confirmations: number; canonical: boolean; receivedAt: number;
  revision: ChainRevision;
};
export type ScanHealth = {
  healthy: boolean; checkedAt: number;
  revision: ChainRevision; caughtUp: boolean;
};
export type Policy = {
  minConfirmations: number; maxHealthAgeMs: number;
};
export type ExceptionRecord = {
  id: string; orderId: string; code: ExceptionCode;
  createdAt: number; detail: string;
};
export type InvoiceSettlement = {
  payment: PaymentState;
  releaseEligible: boolean;
  backingOutputIds: string[];
  exceptions: ExceptionRecord[];
};
export type OrderStatus = {
  payment: PaymentState;
  delivery: DeliveryState;
  verification: Verification;
  exceptions: Array<{ code: ExceptionCode }>;
};
export type BrowserPurchase = {
  version: 1; requestId: string; orderId: string | null;
  productVersion: string;
  sellerOrigin: string; sellerKeyId: string;
  credentialId: string; invoice: Invoice | null;
};
export type DeliveryPackage = {
  orderId: string; productVersion: string; buyerKeyId: string;
  encryptedEnvelope: Uint8Array;
};
export type ReleaseDecision = {
  disclose: boolean;
  reason: 'not_eligible' | 'first_release' | 'replay';
  delivery: DeliveryState;
  package: DeliveryPackage | null;
};
export type ServiceAvailability = {
  productPublished: boolean;
  messaging: boolean;
  storageReplica: boolean;
  scanner: boolean;
};
export function allowNewCheckout(a: ServiceAvailability): boolean {
  return a.productPublished && a.messaging && a.storageReplica && a.scanner;
}

export interface PurchaseStore {
  save(record: BrowserPurchase): Promise<void>;
  get(requestId: string): Promise<BrowserPurchase | null>;
  list(): Promise<BrowserPurchase[]>;
  exportBackup(requestId: string): Promise<Uint8Array>;
  importBackup(data: Uint8Array): Promise<BrowserPurchase>;
}
export interface Scanner {
  health(): Promise<ScanHealth>;
  observations(from: ScanCheckpoint | null): AsyncIterable<Observation>;
}
export interface StorageAdapter {
  publish(ciphertext: Uint8Array): Promise<string>;
  fetch(cid: string): Promise<Uint8Array>;
  verifyReplica(cid: string, replicaId: string): Promise<boolean>;
}
export interface OrderTransport {
  create(record: BrowserPurchase): Promise<Invoice>;
  status(orderId: string, credentialId: string): Promise<OrderStatus>;
  recover(orderId: string, credentialId: string): Promise<DeliveryPackage>;
}
export interface CredentialAdapter {
  createPurchaseCredential(): Promise<{ credentialId: string; buyerKeyId: string; exportable: boolean }>;
  provePossession(credentialId: string): Promise<Uint8Array>;
  verifyPossession(buyerKeyId: string, proof: Uint8Array): Promise<boolean>;
  exportBackupMaterial(credentialId: string): Promise<Uint8Array>;
  importBackupMaterial(data: Uint8Array): Promise<{ credentialId: string; buyerKeyId: string }>;
}
export interface CryptoAdapter {
  encryptProduct(plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; keyRef: string }>;
  sealDelivery(input: {
    orderId: string; productVersion: string; buyerKeyId: string; productKeyRef: string;
  }): Promise<Uint8Array>;
  openDelivery(envelope: Uint8Array, credentialId: string): Promise<{ productKey: Uint8Array }>;
}
export interface ManifestVerifier {
  verify(manifest: Uint8Array, ciphertext: Uint8Array): Promise<boolean>;
}
export interface SellerStore {
  createOrder(input: {
    requestId: string; buyerKeyId: string; productVersion: string;
  }): Promise<{ id: string }>;
  getOrCreateInvoice(input: {
    orderId: string; buyerKeyId: string; productVersion: string; now: number;
    availability: ServiceAvailability;
  }): Promise<Invoice>;
  getInvoice(orderId: string): Promise<Invoice | null>;
  getCheckpoint(): Promise<ScanCheckpoint | null>;
  commitReconciliation(input: {
    checkpoint: ScanCheckpoint;
    observations: Observation[];
    settlements: InvoiceSettlement[];
  }): Promise<void>;
  savePreparedPackage(pkg: DeliveryPackage): Promise<void>;
  getPreparedPackage(orderId: string): Promise<DeliveryPackage | null>;
  getDelivery(orderId: string): Promise<DeliveryState>;
  compareAndSetDelivery(orderId: string, expected: DeliveryState, next: DeliveryState, revision: ChainRevision): Promise<boolean>;
  recordSendAttempt(orderId: string): Promise<void>;
  recordException(record: ExceptionRecord): Promise<void>;
  listExceptions(orderId: string): Promise<ExceptionRecord[]>;
  close(): Promise<void>;
}
```

Amounts are validated canonical unsigned decimal strings at wire/storage boundaries and BigInt during calculation. Do not use floating-point ZEC arithmetic. The selected memo/destination attribution strategy, health freshness threshold, confirmation count and file-size limit are recorded explicitly in Task 3/gate review; startup rejects missing or invalid values. This avoids fabricated upstream guarantees or arbitrary production defaults.

`credentialId` is a local reference, never a server-trusted identity assertion. `OrderTransport` resolves it through the credential adapter to prove possession, then authorizes only if that buyer owns the named order. Network messages require schema version, unpredictable message identity and replay/idempotency behavior established by the selected supported messaging/session implementation.

`prepared` means a reusable package exists and has not been authorized for first disclosure. `queued` means first disclosure is authorized against the current reconciliation revision. `sent_unacknowledged` includes ambiguous sends: a crash after send is initiated is treated as possible disclosure and must not revert to `prepared` or `locked`. Database transactions do not make network delivery atomic.

### Invoice reducer policy

`reduceInvoice(invoice, receipts, health, policy, now)` is the only settlement function used for release. It consumes the invoice's complete deduplicated observation set and is independent of arrival order. `evaluateReceipt` may exist as a helper; it must not authorize release by itself.

- Repeated observations of one `outputId` update that receipt's chain state. They are not a second payment.
- Distinct `outputId` values are distinct payments. Output uniqueness is not duplicate-payment handling.
- Do not aggregate partial payments. If no single canonical receipt is exact or over the invoice amount, `releaseEligible` is false and `review` is `underpayment`.
- One exact or over canonical receipt with configured confirmations, caught-up health at a revision that covers that receipt, and observation time inside expiry: `payment=confirmed`, `releaseEligible=true`. Extra distinct exact/over receipts add a `duplicate` or `overpayment` exception without a second entitlement.
- Overpayment on the backing receipt: fulfill one entitlement and record `overpayment`. Settlement stays `confirmed`.
- If the only backing receipt later has `canonical=false` and no other sufficient receipt remains: `payment=reorged`, `releaseEligible=false`, unless delivery is already `queued` or later (key possibly disclosed). Then record `reorg_after_release` and keep delivery history.
- If one of two sufficient receipts reorgs, the remaining sufficient receipt still confirms.
- Unmatched outputs never satisfy an invoice. Late receipts after `expiresAt` are retained with a `late` exception and do not silently fulfill an expired unpaid invoice.
- A fresh `health.checkedAt` without `caughtUp=true` at a revision covering the backing receipt must not authorize initial release.

### Scanner consumption contract

Gate C must map the selected backend onto this application contract, without inventing SDK methods in this document:

- Seller-owned `ScanCheckpoint` is advanced only after `commitReconciliation` succeeds.
- `observations(from)` must replay every relevant receipt at or after that checkpoint, or the adapter must perform an equivalent authoritative snapshot/rescan covering that range. A live-only stream is insufficient.
- Every `Observation` and `ScanHealth` carries the same `ChainRevision` type. New initial releases wait until `health.caughtUp` is true for the revision under which the backing receipt is canonical.
- Stale or out-of-order updates with an older revision must not overwrite newer committed chain state.
- Reorg rewind is explicit: a later observation for the same `outputId` with `canonical=false` or a lower revision is applied as an update, not a second claim.

## Parallel execution map

```text
Task 0: ignored runtime paths and secret-file policy
             ↓
Tasks 1, 2, 3: independent probes in separate directories
             ↓ parent reviews evidence and pins contracts
Task 4: contracts, schema, durable orders/invoices, credential adapter interface
             ├── Task 5: browser persistence/recovery
             ├── Task 6: product encryption/storage/gateway
             └── Task 7: payments, reducer, shared release authorization
                        ↓
Task 8: buyer screens and end-to-end wiring
                        ↓
Task 9: operational/security/recovery verification
                        ↓
Task 10: real demo and handoff
```

Only the parent edits root dependency manifests, shared contracts, spec and integration report. Probe workers return their own evidence/manifest and never share wallet state or secrets.

Task 4 is the serial shared boundary. It owns `src/contracts/`, `src/seller/schema.sql`, `src/seller/db.ts`, `src/seller/orders.ts`, `src/seller/invoices.ts` and `src/adapters/credentials.ts` (interface plus gate-mapped implementation). After Task 4, parallel workers own disjoint directories and must not edit those files; negotiate shared type changes with the parent before applying them. Disjoint file lists alone do not make Tasks 5–7 independent.

## Task 0: Isolate secrets and runtime state before probes

**Files:** create `.gitignore`; create `spikes/results/README.md` stating evidence must be sanitized.

**Consumes:** nothing. **Produces:** ignored runtime/secret paths used by Tasks 1–3.

- [ ] Create `.gitignore` before any probe runs, including at least:

```
node_modules/
dist/
.env
.env.*
*.key
*.pem
*.sqlite
*.sqlite-*
seller-data/
spikes/**/data/
spikes/**/runtime/
spikes/**/wallets/
playwright-report/
test-results/
coverage/
```

- [ ] Create `spikes/results/` for sanitized evidence only. Record in the results README that private keys, seeds, payment URIs, memos, invoices and buyer credentials are prohibited in saved evidence.
- [ ] Use restrictive permissions on any local secret files created during probes (`0600` files, `0700` directories). Do not copy wallet or node data into the repository.

**Done:** probes cannot accidentally commit runtime state because the ignore rules already exist.

## Task 1: Prove browser messaging and exportable recovery credentials

**Files:** create `spikes/messaging/README.md`, `spikes/messaging/package.json`, probe implementation and tests under `spikes/messaging/`; sanitized results under `spikes/results/messaging.json`.

**Consumes:** documented Logos browser transport and Chat/session implementation. **Produces:** an executed supported implementation choice, authenticated exchange, credential persistence/export method, pinned dependency versions, exact rerun commands, and a routing-metadata inspection result.

- [ ] Read the browser transport docs, then follow official implementation links into the actual package manifest, examples, license and security warnings. Record exact supported package exports and versions in the probe README. Record whether the selected credential store can export recovery material; do not promise export if it cannot.
- [ ] Create a minimal browser/seller probe using those exports. First demonstrate the negative case: wrong seller identity is rejected and a plain delivery acknowledgement does not count as decrypted application response.
- [ ] Run the negative test; record its actual failure before adding the intended implementation. Do not make tests fail solely because a runner or package is missing.
- [ ] Send an encrypted request browser → real Logos network → seller and an authenticated encrypted response back. Neither request nor response may bypass Logos through a private HTTP endpoint.
- [ ] Persist purchase credentials in IndexedDB; close the browser process, reopen the same profile and prove possession again. Export optional recovery material and restore in a fresh browser context.
- [ ] Interrupt transport, reconnect, resend the same request and demonstrate one logical order response. Test incorrect credentials and replayed authorization.
- [ ] Inspect observable public topics and envelope metadata using synthetic markers `ORDER_MARK`, `BUYER_MARK` and `PRODUCT_MARK`. Fail if any marker appears in routing topics or unencrypted envelope fields. Network timing and IP metadata may remain visible.
- [ ] Save exact package pins, launch/test commands, sanitized logs, message routing observations and observed latency. No private credentials, invoices, payment URIs or memos in evidence.

**Pass:** encryption, seller authentication, browser restart, export/import, real Logos transport and the routing-marker prohibition all work. **Stop:** no compatible browser/session library; report the blocker and seek design revision. Do not invent homemade authentication to bypass it.

## Task 2: Prove encrypted browser downloads and independent storage

**Files:** create `spikes/storage/README.md`, probe code/tests under `spikes/storage/`, sanitized `spikes/results/storage.json`.

**Consumes:** actual Logos Storage module APIs and maintained authenticated encryption implementation. **Produces:** pinned native module/adaptor commands, ciphertext format, tested browser size limit, independent replica retrieval evidence.

- [ ] Inspect the documented module upload/download completion events; distinguish command acceptance from completed operations. Pin a compatible module version.
- [ ] Start two independently stored Logos nodes using supported tooling. Keep runtime configs/data in the Task 0 ignored directories, never in source control. Do not run downloaded privileged install scripts without inspecting and obtaining necessary authorization.
- [ ] Write a test that attempts to decrypt modified ciphertext and requires rejection before exposing plaintext.
- [ ] Encrypt a harmless fixture with the selected maintained implementation; upload the ciphertext and await actual completion.
- [ ] Retrieve through the second node and compare ciphertext digest. Stop the original node and retrieve again through the second node; show that a missing cache does not silently fetch a local plaintext fixture.
- [ ] Serve only that ciphertext via a restricted local HTTPS test gateway. Decrypt in a browser and compare plaintext to the fixture. Test filename/path abuse and unknown identifiers.
- [ ] Exercise small and progressively larger fixtures; record memory/retrieval behavior and set an explicit maximum size supported by the first release. Do not claim streaming unless the selected implementation actually streams safely.
- [ ] Record real module methods, config requirements, command output and independent-node identity/storage separation.

**Pass:** genuine independent ciphertext retrieval and local authenticated decryption. **Stop:** availability or integrity failures. No cloud-object-store substitution labelled as Logos.

## Task 3: Prove Zcash scanner, invoice attribution and wallet handoff

**Files:** create `spikes/payments/README.md`, selected scanner probe and tests under `spikes/payments/`, sanitized `spikes/results/payments.json`; parent creates `docs/integration-report.md`.

**Consumes:** ZIP-321, selected wallet/scanner implementation and test funds. **Produces:** wallet compatibility evidence, scanner API mapping onto `Scanner`/`ScanCheckpoint`/`ChainRevision`, testnet-only configuration, attribution strategy and confirmation/health policies.

- [ ] Inspect candidate wallet/scanner code and documented viewing-only capability. Record maintenance/license/security caveats. Do not treat a prototype tool's existence as production safety.
- [ ] Select one supported testnet wallet; verify it preserves the required receiver and memo fields. Prefer per-invoice shielded destinations only if the scanner can actually map them; otherwise prove the random-memo route. No amount-only matching.
- [ ] Write a scanner contract test using an unmatched output; confirm it cannot release an invoice. Define stable output identity including pool/output position where needed, not transaction ID alone.
- [ ] Generate a testnet payment request; use a compatible wallet and actual test funds. Follow vault/secure credential handling, never putting seed phrases in chat or command arguments.
- [ ] Observe the real shielded receipt with the service's viewing-only capability. Record synchronization health and confirmation progression. Verify an unrelated equal-amount payment does not match.
- [ ] Prove replay from a seller-owned checkpoint: deliver an observation, crash the consumer before commit, restart, and recover the same output without depending on a live-only cursor. Separately receive a payment while the consumer is stopped and recover it after restart. If the backend cannot replay, demonstrate an equivalent snapshot/rescan covering the checkpoint range. Record the chosen mapping in the gate report.
- [ ] Bind health and observations to one revision type. Show that `healthy=true` with `caughtUp=false`, or with a revision that does not cover a stored receipt, cannot authorize release. Apply a later non-canonical update for the same output and show it replaces the older chain state rather than creating a second claim.
- [ ] Replay an observed output and prove no second invoice can claim it. Use synthetic chain-state tests for reorg behavior where a real public-testnet reorg is not available; label them synthetic.
- [ ] Record the positive confirmation count, health freshness limit, invoice expiry/late-payment policy and all backend versions. Document wallet URI/QR behavior actually observed.
- [ ] Parent reviews all probe artifacts and writes `docs/integration-report.md`: pass/fail per requirement, exact imports/API calls, rerun commands, licenses, limitations and pinned dependencies. Update application contracts if probe evidence requires it, without changing approved scope silently.

**Hard checkpoint:** Tasks 4–10 are blocked until the parent accepts all three probe results and reconciles this plan's adapter mappings. If test funds, wallet support or viewing-only scanning are unavailable, report a blocker; never generate fake settlement evidence.

## Task 4: Establish contracts, schema and durable order/invoice issuance

**Files:** create root manifests/configuration, `src/contracts/types.ts`, `src/contracts/validation.ts`, `src/seller/schema.sql`, `src/seller/db.ts`, `src/seller/orders.ts`, `src/seller/invoices.ts`, `src/adapters/credentials.ts`, `tests/unit/orders.test.ts`, `tests/unit/invoices.test.ts`, `tests/unit/validation.test.ts`, `tests/unit/credentials.test.ts`.

**Consumes:** accepted gate report. **Produces:** the contracts above; `openStore(path: string): Promise<SellerStore>` with working persistence primitives; durable `createOrder` and `getOrCreateInvoice`; `CredentialAdapter` mapped to the Gate A library, plus a test double.

Schema ownership is this task. `schema.sql` includes tables and constraints for orders, invoices, products, product keys, observations, checkpoints, outbox, delivery packages, delivery state, exceptions and seller identity references even if later tasks fill the rows. Later tasks must not add conflicting migrations. `reduceInvoice` and `authorizeRelease` remain Task 7; this task only persists the rows those functions will write.

- [ ] Create project-local pinned tooling. Define `test` as `vitest run`, `typecheck` as `tsc --noEmit`, `build` as the browser and service build, `test:browser` as `playwright test`, and explicit integration scripts. No inherited parent-repo scripts.
- [ ] Write the order idempotency test with temporary database paths under the configured workspace scratch location and cleanup. Run `npm test -- tests/unit/orders.test.ts`; require a meaningful missing-behavior failure after tooling works.

```ts
const input = {requestId: 'retry-1', buyerKeyId: 'buyer-a', productVersion: 'book-v1'};
const first = await store.createOrder(input);
await store.close();
store = await openStore(dbPath);
expect((await store.createOrder(input)).id).toBe(first.id);
await expect(store.createOrder({...input, productVersion: 'other-v1'})).rejects.toThrow();
```

- [ ] Write the invoice durability test and run it red:

```ts
const availability = {productPublished: true, messaging: true, storageReplica: true, scanner: true};
const order = await store.createOrder({requestId: 'retry-1', buyerKeyId: 'buyer-a', productVersion: 'book-v1'});
const first = await store.getOrCreateInvoice({
  orderId: order.id, buyerKeyId: 'buyer-a', productVersion: 'book-v1', now: 1000, availability,
});
await store.close();
store = await openStore(dbPath);
const again = await store.getOrCreateInvoice({
  orderId: order.id, buyerKeyId: 'buyer-a', productVersion: 'book-v1', now: 1500, availability,
});
expect(again).toEqual(first);
expect(again.amountZat).toBe(first.amountZat);
expect(again.destination).toBe(first.destination);
expect(again.attributionRef).toBe(first.attributionRef);
expect(again.productVersion).toBe('book-v1');
expect(again.expiresAt).toBe(first.expiresAt);
await expect(store.getOrCreateInvoice({
  orderId: order.id, buyerKeyId: 'buyer-b', productVersion: 'book-v1', now: 1600, availability,
})).rejects.toThrow();
const stillIssued = await store.getOrCreateInvoice({
  orderId: order.id, buyerKeyId: 'buyer-a', productVersion: 'book-v1', now: 1700,
  availability: {...availability, scanner: false},
});
expect(stillIssued.id).toBe(first.id);
const blocked = await store.createOrder({requestId: 'new-2', buyerKeyId: 'buyer-a', productVersion: 'book-v1'});
await expect(store.getOrCreateInvoice({
  orderId: blocked.id, buyerKeyId: 'buyer-a', productVersion: 'book-v1', now: 1800,
  availability: {...availability, scanner: false},
})).rejects.toThrow();
```

- [ ] Implement schema migrations, immutable invoice/product references, unique buyer/request idempotency and unique output claims. Allocate destination or memo attribution using the Gate C strategy inside `getOrCreateInvoice`. Bind `buyerKeyId` from the authenticated credential, never from an untrusted payload field. Reject changed request terms rather than silently reuse an incompatible order. Reject new invoices when `allowNewCheckout(availability)` is false; do not mutate an existing invoice's terms.
- [ ] Implement the remaining `SellerStore` persistence primitives: `commitReconciliation` advances `ScanCheckpoint` only after observations, settlements and exceptions write in the same transaction; `compareAndSetDelivery` is atomic; `savePreparedPackage` is unique per order. A crash injected after a delivered observation and before commit must leave the previous checkpoint unchanged.
- [ ] Add strict runtime validators: reject unknown network, negative/noncanonical amount strings, malformed payloads, excessive payload sizes and invalid state names. Resolve valid cryptographic identity/address validation through the gate-selected libraries.
- [ ] Implement `CredentialAdapter` against the Gate A library. Test that two `createPurchaseCredential()` calls yield different `credentialId`/`buyerKeyId` values, and that prove/verify fails for a different key.
- [ ] Run targeted tests, `npm run typecheck`, and `npm run build`. Reopen the database in tests; in-memory-only passing tests are insufficient.

**Done:** durable order and invoice issuance, schema ownership, persistence primitives and credential interface are independently tested. Tasks 5–7 may proceed against these contracts.

## Task 5: Automatic local recovery and optional backups

**Files:** create `src/browser/purchases.ts`, `src/browser/checkout.ts`, `tests/browser/recovery.spec.ts`, `tests/unit/checkout.test.ts`; create Playwright configuration here if needed.

**Consumes:** `BrowserPurchase`, `PurchaseStore`, `OrderTransport`, Task 4 `CredentialAdapter`. **Produces:** `beginCheckout(store: PurchaseStore, transport: OrderTransport, credentials: CredentialAdapter, draft: Pick<BrowserPurchase, 'version' | 'requestId' | 'productVersion' | 'sellerOrigin' | 'sellerKeyId'>): Promise<Invoice>`.

- [ ] Write the ordering/failure test and run it red. Define `rejectingStore` as a PurchaseStore whose `save` rejects, and `transport` as a test-only OrderTransport spy.

```ts
await expect(beginCheckout(rejectingStore, transport, credentials, draft)).rejects.toThrow();
expect(transport.create).not.toHaveBeenCalled();
```

- [ ] Implement: if `store.get(draft.requestId)` already has a `credentialId`, reuse it; otherwise create a fresh purchase credential. Save draft including `productVersion` and `credentialId`; read back and verify credential usability; request invoice with that record; verify binding to product version, buyer, network, amount and invoice terms; save updated record; read back; only then return invoice for wallet display. If the second save fails, do not display payment instructions; replay the same request ID after recovery.
- [ ] Write the interrupt-before-invoice-persist test:

```ts
await store.save({...draft, credentialId: 'cred-1', orderId: null, invoice: null, productVersion: 'book-v1'});
expect((await store.get(draft.requestId))?.invoice).toBeNull();
const invoice = await beginCheckout(store, transport, credentials, draft);
expect(credentials.createPurchaseCredential).not.toHaveBeenCalled();
expect(transport.create).toHaveBeenCalledWith(expect.objectContaining({
  requestId: draft.requestId, productVersion: 'book-v1', credentialId: 'cred-1',
}));
expect(invoice.productVersion).toBe('book-v1');
```

Retries of the same `requestId` must reuse the original credential and receive the same invoice terms. A second distinct checkout must call `createPurchaseCredential()` again.

- [ ] Implement IndexedDB transaction completion, schema versioning, strict import validation, same-origin seller binding and optional portable backup using the gate-approved credential format. Do not silently trust imported seller identities or execute imported content.
- [ ] Show a bearer-secret warning at export and in recovery guidance: the file grants access to the purchase and is not an ordinary receipt. Test that the warning is visible. Password encryption of the backup remains a Gate A decision; do not invent a mandatory password requirement.
- [ ] Test actual close/reopen of a persistent browser context, storage quota/permission failure, private-session storage loss behavior, malformed/future backup versions, fresh-context import and wrong-seller identity.
- [ ] Test `navigator.storage.persist` rejection/absence without breaking normal stored checkout. When storage fails, first release may block payment and offer backup/retry guidance; never pretend persistence succeeded.
- [ ] If the recovered invoice is expired and unpaid, do not present ordinary payment instructions. The buyer may start a new checkout with a new request ID; the old invoice terms stay unchanged for late-payment monitoring.
- [ ] Run `npm test -- tests/unit/checkout.test.ts` and `npm run test:browser -- tests/browser/recovery.spec.ts`.

**Done:** same-browser recovery automatic; backup optional and labelled as a bearer secret; no secret in URL/history/logs; manual-backup fallback, if offered, must demonstrate re-import before payment rather than merely triggering a file download.

## Task 6: Publish encrypted products and serve only authorized ciphertext

**Files:** create `src/seller/catalogue.ts`, `src/seller/admin.ts`, `src/adapters/storage.ts`, `src/adapters/crypto.ts`, `src/gateway/ciphertext.ts`, `src/browser/download.ts`, `tests/unit/gateway.test.ts`, `tests/unit/availability.test.ts`, `tests/integration/storage.test.ts`.

**Consumes:** gate-tested ciphertext format, `ManifestVerifier`, `CryptoAdapter`, `StorageAdapter`, Task 4 schema. **Produces:** immutable product manifests; `getPublishedCiphertext(productVersion: string): Promise<Uint8Array>`; `currentAvailability(): Promise<ServiceAvailability>`; `decryptDownload(pkg: DeliveryPackage, ciphertext: Uint8Array): Promise<Blob>` using verified package contents.

- [ ] Write gateway tests for unpublished product, traversal input, arbitrary URL, invalid identifier, oversize content, excess concurrency and disconnected replica. Require errors without upstream arbitrary fetches.
- [ ] Implement local/private publish command: validate metadata/size, encrypt, upload, wait for completion, verify independent replica and atomically publish the immutable manifest. Failed publication must not expose an apparently purchasable listing.
- [ ] Implement allowlisted ciphertext lookup and strict bounded transfer. Do not expose native Logos management methods or plaintext decryption keys through the endpoint.
- [ ] Implement authenticated manifest checking and local decryption with gate-selected primitives; reject corruption before making plaintext available. Download as an attachment, never render arbitrary purchased HTML on the app origin.
- [ ] Implement `currentAvailability()` from product publication, messaging, storage-replica retrieval and scanner health. After a successful publish, mark a required dependency unavailable and assert `allowNewCheckout` is false while existing paid recovery remains possible.
- [ ] Test that old product versions remain retrievable after price/content updates for existing purchases, and deletion is refused while required references exist.
- [ ] Run `npm test -- tests/unit/gateway.test.ts tests/unit/availability.test.ts`; run the real storage integration using the command recorded in the gate report, then `npm run test:integration -- tests/integration/storage.test.ts` once the root wrapper is wired.

**Done:** publish-to-replica-to-browser works with real storage; privacy limits visible; size bound enforced before resource exhaustion; known-unavailable dependencies block new checkout.

## Task 7: Payment reconciliation and crash-safe fulfillment

**Files:** create `src/seller/payments.ts`, `src/seller/fulfillment.ts`, `src/adapters/scanner.ts`, `src/adapters/messaging.ts`, `tests/unit/payments.test.ts`, `tests/unit/invoice-reduce.test.ts`, `tests/unit/fulfillment.test.ts`, `tests/integration/payment.test.ts`.

**Consumes:** Invoice, Observation, ScanHealth, Policy, Scanner, SellerStore, gate-tested encrypted messaging. **Produces:** `reduceInvoice(invoice: Invoice, receipts: Observation[], health: ScanHealth, policy: Policy, now: number): InvoiceSettlement`; `reconcileObservation(observation: Observation): Promise<void>`; `authorizeRelease(orderId: string): Promise<ReleaseDecision>` used by both the outbox worker and recovery after buyer authorization; `dispatchPending(): Promise<void>`.

- [ ] Write red tests for the invoice reducer. Example values are test fixtures, not the chosen live confirmation default.

```ts
const invoice: Invoice = {id:'i1', orderId:'o1', productVersion:'v1', buyerKeyId:'b1',
  network:'test', amountZat:'100', destination:'fixture-only', attributionRef:'r1', expiresAt:2000};
const rev = {id:'rev-2', height:2};
const receipt: Observation = {outputId:'out-a', invoiceId:'i1', amountZat:'100',
  confirmations:2, canonical:true, receivedAt:1000, revision:rev};
const health: ScanHealth = {healthy:true, checkedAt:1000, revision:rev, caughtUp:true};
const policy: Policy = {minConfirmations:2, maxHealthAgeMs:100};
expect(reduceInvoice(invoice, [receipt], health, policy, 1000).releaseEligible).toBe(true);
expect(reduceInvoice(invoice, [{...receipt, confirmations:0}], health, policy, 1000).releaseEligible).toBe(false);
expect(reduceInvoice(invoice, [{...receipt, invoiceId:null}], health, policy, 1000).releaseEligible).toBe(false);
expect(reduceInvoice(invoice, [receipt], {...health, caughtUp:false}, policy, 1000).releaseEligible).toBe(false);
expect(reduceInvoice(invoice, [receipt], {...health, revision:{id:'rev-1', height:1}}, policy, 1000).releaseEligible).toBe(false);
```

- [ ] Add reducer cases, independent of arrival order:
  - two observations of one `outputId` update chain state once;
  - two distinct exact outputs: one entitlement plus `duplicate` exception;
  - two partial outputs: `underpayment`, no release;
  - exact payment then a small/late extra output: remains confirmed, extra exception, no second entitlement;
  - two sufficient outputs, one later `canonical=false`: still confirmed on the remaining output;
  - sole sufficient output later non-canonical before disclosure: `reorged`, not eligible;
  - observation time after `expiresAt` with no prior confirmation: `late`, not eligible.
- [ ] Use `commitReconciliation` so the checkpoint advances only after observations, invoice settlements, exceptions and outbox changes commit in one transaction. Inject a crash after an observation is delivered and before commit; restart must recover that output through `observations(from)` without losing or double-claiming it.
- [ ] Persist confirmation and a unique `prepared` package in the same transaction when settlement first becomes eligible. Package existence is not disclosure.
- [ ] Implement `authorizeRelease` as the only first-disclosure gate for the worker **and** recovery. Recheck `reduceInvoice` against current committed receipts and caught-up health. On success, `compareAndSetDelivery(orderId, 'prepared', 'queued', revision)` and return `disclose=true`, `reason='first_release'`. If delivery is already `queued` or later, return `reason='replay'` with the existing package. If not eligible and never authorized, return `disclose=false` even when a prepared package exists. Do not disclose from a failed compare-and-set.
- [ ] Worker send path: call `authorizeRelease`, send, then `recordSendAttempt`. If the process crashes after send is initiated, persist `sent_unacknowledged` (possible disclosure). Do not imply the database transaction made the send atomic.
- [ ] Inject crashes before/after transaction commit and before/after message send. Restart; allow duplicate delivery of the same entitlement, never duplicate authorization or a second payment requirement.
- [ ] Authenticated recovery proves the original buyer credential **then** calls `authorizeRelease`. Reject wrong buyers, order-ID-only access, and buyer A's valid credential against buyer B's order before any disclosure decision. The same ownership rule applies to `status`. Bind acknowledgements to the order and authenticated sender.
- [ ] Test prepare → crash before send → payment reorg → recover: `disclose` must be false. Test concurrent reconciliation and dispatch so a reorg cannot interleave after the eligibility check and before authorization is recorded.
- [ ] Simulate reorg before release (hold) and after release (exception, preserve delivery evidence). Verify scanner outage sets `verification` to `unavailable` or `stale`, records `verification_unavailable`, and halts new release decisions without incorrectly marking purchases unpaid.
- [ ] Persist exceptions independently of payment/delivery enums so confirmed-plus-overpayment and awaiting-plus-verification-unavailable are both representable. Expose them through `OrderStatus` and private merchant status tooling. No automatic refund feature.
- [ ] Run `npm test -- tests/unit/payments.test.ts tests/unit/invoice-reduce.test.ts tests/unit/fulfillment.test.ts`; run the actual testnet integration separately and label every fixture.

**Done:** durable payment-to-delivery transition, checkpointed scanner consumption, invoice-level settlement, shared release authorization and reorg behavior verified.

## Task 8: Four-screen browser application and real-adapter composition

**Files:** create `src/browser/app.ts`, `src/seller/server.ts`, `src/config.ts`, `src/main.ts`, `index.html`, local assets, `tests/browser/purchase.spec.ts`, `tests/unit/config.test.ts`.

**Consumes:** completed core, PurchaseStore, OrderTransport, catalogue, availability and gateway. **Produces:** runnable seller deployment and browser checkout with explicit real/fixture modes.

- [ ] Write browser assertions before UI implementation: no email/registration requirement; wallet request absent until persistence; confirming distinct from paid; failed delivery never labelled unpaid; confirmed-plus-review visible as paid with a separate exception; awaiting-plus-verification-unavailable visible as scanner problem, not as unpaid.
- [ ] Implement accessible Product, Checkout, Purchase status and My purchases views. Show fixed ZEC price, file details, seller identity and testnet badge. Show reconnect/stale-scanner states from `OrderStatus.verification`, not from local inference.
- [ ] Refuse new checkout in the Product view and in `getOrCreateInvoice` when `allowNewCheckout(currentAvailability())` is false. Existing purchase recovery remains available.
- [ ] Do not redisplay ordinary payment instructions for an expired unpaid invoice. Offer a new checkout only as a new request ID.
- [ ] Render QR from the exact verified ZIP-321 URI and provide a copy/link alternative. Verify memo/receiver behavior on the actual selected wallet; never claim broad compatibility from a browser-only test.
- [ ] Wire encrypted messages through the real adapter; all client status is informational until confirmed by seller-authenticated responses. No browser payment override endpoints. Status and recover requests include possession proofs bound to the target order.
- [ ] Configure strict CSP, local-only assets and attachment download behavior. Runtime secrets do not enter browser bundles. Bind merchant administration separately from public routes. Repeat the bearer-secret backup warning on My purchases export.
- [ ] Startup rejects non-testnet settings, nonpositive confirmation thresholds, missing freshness/size limits, and fixture adapters in real-demo mode. Test these failures; do not quietly default to mocks when upstream services fail.
- [ ] Run `npm run typecheck`, `npm run build`, deterministic suites and `npm run test:browser -- tests/browser/purchase.spec.ts`.

**Done:** a usable browser flow composed from verified components, not a polished facade over fake payment state.

## Task 9: Security boundaries, seller backups and operational recovery

**Files:** create `tests/unit/security.test.ts`, `tests/unit/logs.test.ts`, `tests/browser/privacy.spec.ts`, `scripts/backup-check.ts`, `docs/runbook.md`; update deployment configuration only inside this project.

**Consumes:** runnable deployment. **Produces:** tested recovery procedure, allowlisted logging, and explicit operator trust/availability guidance.

- [ ] Capture browser requests and assert no third-party analytics/scripts, credentials in URLs or unexpected plaintext delivery.
- [ ] Define an allowlisted operational log schema. Insert distinct synthetic markers for an invoice record, memo/attribution reference and payment URI on success and error paths. Inspect service, adapter/scanner, HTTP and saved probe evidence; fail if a marker appears. Prohibit whole-record logging. Sentinel private keys remain required absences, not the only ones.
- [ ] Re-check public routing topics with the same order/buyer/product markers against the wired adapter, not only the Task 1 probe.
- [ ] Test malicious imports, cross-origin access, wrong seller identity, wrong buyer proof, buyer A status/recovery against buyer B's order, replayed messages, unauthorized admin access and gateway request exhaustion. Do not label the result a formal security audit.
- [ ] Create seller backup procedure covering database consistency, product keys, viewing/attribution state, **and** the seller messaging/authentication identity plus any library-required session material. Use the selected maintained encryption tooling. Restore into a separate isolated instance. Prove a preexisting paid purchase can recover through the real authenticated transport using an **unchanged pre-loss buyer record**, without resetting that record's seller trust anchor and without transferring spending keys.
- [ ] Document origin continuity: a restored identity still has to be served from the origin the buyer pinned. Document the backup recovery-point limitation (state after the backup is not guaranteed).
- [ ] Test unavailable storage, scanner outage and seller restart while showing honest buyer status. Document maximum retention/availability promises actually supported.
- [ ] Document native dependencies, ports, private/public binding, TLS requirements, key ownership, threat limits, fixture mode, testnet wallet setup and safe shutdown. Never include credentials in examples.
- [ ] Run security, log and privacy suites, then the restore script using disposable test data. Save sanitized results and any unresolved blockers.

**Done:** repeatable seller recovery including seller identity, strict boundary tests and an honest runbook, not only happy-path screenshots.

## Task 10: Real integrated demo and completion report

**Files:** create `scripts/demo-check.ts`, `docs/demo-results.md`; update `README.md` with setup/design/plan/runbook links while preserving research.

**Consumes:** all previous tasks. **Produces:** independently rerunnable verified MVP.

- [ ] Preflight versions, testnet selection, healthy caught-up scanner, real adapters, TLS/browser origin and independent storage replica. Fail fast if prerequisites are absent.
- [ ] Publish a harmless digital product, open browser checkout, perform an actual shielded testnet payment through the selected wallet and observe confirmation-driven fulfillment.
- [ ] Close buyer before delivery, restart seller, reopen same browser and recover without re-paying.
- [ ] Stop original storage node and retrieve ciphertext from the independent replica. Verify decrypted file contents against the known harmless fixture.
- [ ] Export optional backup, confirm the bearer-secret warning, and recover in a fresh browser context. Clear both local state and backup in a separate test and confirm the UI makes no false recovery promise.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, `npm run test:browser` and the explicit real integration suite. Record exact commands/exit status; skipped tests do not count as passing.
- [ ] Record observed scan/confirmation/fulfillment/retrieval delays separately, file sizes, resource measurements, dependency versions and privacy limitations. Redact purchase secrets; testnet transaction identifiers may be recorded only with appropriate disclosure.
- [ ] Complete the matrix below with evidence references. Keep code uncommitted unless the user authorizes commits; use Conventional Commits if authorized.

## Acceptance and spec coverage matrix

| Requirement | Tasks | Required evidence |
|---|---|---|
| Real browser Logos encrypted messaging | 1, 8, 10 | Browser/seller exchange, reconnect and authentication |
| Public routing minimization | 1, 9 | Synthetic order/buyer/product markers absent from topics |
| Independent encrypted storage retrieval | 2, 6, 10 | Original node stopped, independent retrieval and local decryption |
| Shielded payment verification | 3, 7, 10 | Real testnet receipt, attribution and confirmations |
| Scanner replay/checkpoint | 3, 7 | Crash-before-commit and payment-during-downtime recovery |
| Chain-revision catch-up | 3, 7 | Fresh health without covering revision cannot release |
| Durable schema/idempotency | 4, 7 | Disk reopen, duplicate request/output tests |
| Durable invoice issuance | 4 | Unchanged id/amount/destination/attribution/expiry after restart |
| Automatic browser recovery | 5, 8, 10 | Persistent browser restart, no manual import |
| Draft includes product version | 5 | Interrupt before invoice persist still replays create |
| Purchase-specific credentials | 4, 5 | Two purchases differ; retry reuses the original |
| Optional portable recovery | 1, 5, 10 | Fresh-context import, authentication and bearer-secret warning |
| Payment/delivery separation | 7, 8 | Paid-but-retrying UI and persisted states |
| Invoice-level settlement | 7 | Distinct-output surplus, no partial aggregation, single-receipt reorg |
| Shared first-release authorization | 7 | prepare→crash→reorg→recover does not disclose |
| Status exceptions | 7, 8 | Confirmed-plus-review and verification-unavailable |
| Cross-order authorization | 7, 8 | Buyer A cannot status or recover buyer B's order |
| Exception policy/reorgs | 7 | Deterministic decision/crash tests, honestly labelled |
| Checkout availability | 6, 8 | Known-unavailable dependency rejects new invoices |
| Expired invoice closure | 5, 7, 8 | No ordinary payment instructions; late monitoring retained |
| Confidentiality/authentication | 1, 2, 6, 7, 9 | Wrong identity/corrupt envelope rejection |
| Public/admin separation | 6, 8, 9 | Unauthorized admin and gateway-abuse rejection |
| Buyer metadata minimization | 5, 8, 9 | Request/log inspection, allowlisted logs, no third-party checkout scripts |
| Seller loss recovery | 9 | Isolated restore of db/keys/viewing/seller identity; pre-loss buyer record |
| Safe real-demo configuration | 8, 10 | Mainnet/fixture/invalid-policy startup rejection |
| Honest scale/readiness claims | 2, 10 | Measured limits, not invented capacity estimates |

## Execution recommendation

Run Task 0 first, then isolated parallel workers for Tasks 1–3, then parent review at the hard gate. Task 4 remains serial. After shared contracts, schema, invoice issuance and the credential adapter are accepted, Tasks 5–7 can run in disjoint workstreams. Keep UI integration, security review and the final live demo sequential where they depend on combined behavior.

Approval of this plan is not evidence the product works. Do not mark the MVP complete until the real demo and acceptance matrix are backed by execution results.
