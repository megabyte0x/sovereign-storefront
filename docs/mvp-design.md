# Sovereign Storefront — MVP design

Status: approved by the user. Implementation not started. Integration gates remain mandatory; approval does not establish dependency compatibility.

## Approved user experience

- Browser-first purchase experience.
- Automatic same-browser recovery through IndexedDB; portable backup is optional, not a mandatory checkout step.
- Product, Checkout, Purchase status, and My purchases screens.
- Separate payment and delivery states. A paid order with failed delivery remains paid.
- Recovery authenticates possession of buyer credentials. An order ID alone never grants access.

The architecture and behavior below are approved at design level. Library compatibility, scanner choice and other integration-gated details must be established by real probes before implementation commitments.

## 1. Goal and scope

Allow one seller to publish an encrypted digital download, receive shielded Zcash testnet payment, and reliably deliver access through a browser using Logos messaging and storage.

The acceptance demonstration is a real purchase interrupted before delivery, recovered in the same browser after seller restart, with ciphertext retrieved from an independent Logos replica after the original storage node stops.

Include one seller per deployment, one-time downloads, fixed ZEC pricing, private/local merchant administration, durable fulfillment, automatic local recovery and optional portable backup.

Exclude marketplace discovery, hosted multi-tenancy, subscriptions, escrow, fiat conversion, automatic refunds, physical products, DRM and production-money deployment. Do not introduce a bridge or LEZ asset.

## 2. Deployment and components

### Browser application

Renders public product metadata and buyer screens. Generates purchase-specific credentials, stores them locally, exchanges encrypted order messages, hands payment requests to an external wallet, retrieves ciphertext and decrypts locally. It never asks for a Zcash seed phrase or spending key.

No third-party scripts or analytics on checkout and purchase pages. Use a restrictive content security policy and avoid rendering purchased HTML inside the application origin. Download content as an attachment rather than executing it.

### Seller service

Owns catalogue, invoices, payment reconciliation, fulfillment records and retry scheduling. Holds product encryption keys and the minimum wallet viewing capability required by the selected scanner. Keep spending authority outside this service.

Merchant administration is local/private in the MVP. Public clients cannot upload products, change prices, read arbitrary orders, export wallet data or call node administration.

### Logos messaging adapter

Carries encrypted order requests, invoices, status/recovery requests and fulfillment responses. Provides reconnect, bounded retries and duplicate handling. Select a supported authenticated encryption/session implementation after proving browser and seller compatibility; do not create a custom cryptographic protocol merely to satisfy this interface.

Authenticate the seller against a key anchored in the storefront configuration. This does not eliminate trust in the origin serving the application. Do not encode order IDs, buyer identities or product names in public routing topics.

### Logos storage adapter and ciphertext gateway

Publish encrypted product bytes to a seller-controlled Logos node and deliberately replicate them to an independent node. The browser accesses a narrow HTTPS ciphertext endpoint, not native node-management APIs.

The gateway accepts only validated identifiers for explicitly published products, with size, concurrency and request limits. No arbitrary URLs, filesystem paths or general RPC proxy. It serves ciphertext only and never receives buyer decryption keys. It can observe IPs, identifiers, sizes and timing.

Replica availability must be checked by retrieval, not inferred from an accepted upload request. Retain immutable product versions required by outstanding invoices and paid purchases.

### Zcash scanner adapter

Reconciles wallet-observed incoming shielded payments with invoices. Reports stable output identifiers, amount, destination attribution, block height, confirmation status and synchronization health as available through the selected backend.

No client assertion, transaction ID, screenshot or wallet-open event authorizes delivery. No transparent fallback. No zero-confirmation release in the MVP. A documented positive confirmation threshold is a configuration requirement; select and test it during integration verification rather than claim it is risk-free.

### Durable database

Use transactional local persistence for a single seller. SQLite is the proposed default, subject to the selected backend's concurrency needs. Payment observations, state changes and fulfillment jobs must survive process restart. A retryable outbox links committed state to external messaging without claiming exactly-once network delivery.

## 3. Logical records

These are proposed application records, not claims about existing upstream APIs.

- ProductVersion: immutable ID, public description, fixed integer-zatoshi price, ciphertext identifier and digest, encrypted-file format version, file size, seller key reference and availability status.
- Order: unpredictable ID, product version, buyer public credential, request idempotency key and creation time.
- Invoice: order ID, network, expected amount, shielded destination, attribution strategy, expiry policy and immutable terms.
- PaymentObservation: stable transaction/output identity, invoice match, received amount, mined height, chain status and last reconciliation time. One output must not satisfy multiple invoices.
- Fulfillment: order ID, delivery package reference, release state, retry metadata and acknowledgement time. Never log plaintext product keys.
- Outbox: operation identity, payload reference, retry schedule and completion status. Sensitive contents require the same protection as the database and keys.
- BrowserPurchase: schema version, seller origin/key identity, order ID, product summary, local credential references and last-known status. Local status is a cache, not settlement authority.

Choose and prove one invoice-attribution method during the integration gate: per-invoice shielded receiving destination, or a random memo reference preserved by the selected wallet. Do not fall back to amount-only matching. The choice is an explicit dependency, not an implementation detail to guess later.

## 4. Buyer journey

### Product

Show description, file type/size, fixed ZEC price, testnet badge and seller identity. Do not offer new checkout while dependencies are known unavailable. A successful availability check cannot guarantee uninterrupted future delivery.

### Checkout

1. Generate purchase-specific credentials using the selected library.
2. Commit credentials and request idempotency identity to IndexedDB; read back the required record.
3. Submit an authenticated encrypted order request.
4. Verify the seller response and its binding to product version, buyer credential, network, amount and invoice terms.
5. Persist the invoice/order before presenting its payment request.
6. Show QR and wallet link. Buyer authorizes in their own wallet.

If persistence fails, offer an explicit portable-backup fallback or stop before presenting payment instructions. Successful readback proves current storage, not permanent retention. Persistent-storage requests are best-effort. Never claim reliable private-browsing detection.

### Purchase status

Show waiting, confirming, paid/preparing, ready, or a specific exception. Reconnect and refresh status using authenticated messages. Display payment detection separately from confirmation and make scanner outages visible rather than infer that no payment occurred.

### My purchases

Load local records automatically. Resume pending orders and retrieve existing delivery packages after authentication. Offer optional export/import of a versioned recovery backup; treat it as a bearer-sensitive secret, not an ordinary receipt.

Private keys must not appear in URLs, logs or analytics. Portable backup format and exportable/non-exportable browser-key choices require a deliberate design during the crypto compatibility gate; the application must not promise export if the chosen key storage cannot support it.

Same-origin browser storage does not follow users to another domain, profile or device. Clearing site data or losing a device can destroy recovery. Loss of both local credentials and backup has no guaranteed recovery path.

## 5. Payment and delivery state machines

Payment states: awaiting, detected, confirming, confirmed, review_required, reorged. An expired unpaid invoice is closed for ordinary checkout but must still be checked for late receipts.

Delivery states: locked, queued, sent_unacknowledged, acknowledged, retry_required.

A durable confirmed-payment transition queues fulfillment atomically. The worker rechecks release eligibility before initial dispatch. Repeated messages resend the same order-bound entitlement; they do not create new purchases. Acknowledgement means the client acknowledged receipt, not proof that a person opened or understood the product.

Payment changes never erase delivery history. A reorganization before dispatch prevents release until eligible again. A reorganization after dispatch creates a seller-visible exception; it cannot undo a key already disclosed.

### Exception policy for the MVP

- Underpayment: review_required; no automatic fulfillment or automatic aggregation across unrelated payments.
- Exact valid payment: fulfill after configured confirmations and healthy reconciliation.
- Overpayment: fulfill the purchased entitlement after confirmations; separately flag the excess for manual review. No automatic refund.
- Duplicate payment: no second entitlement; flag surplus for review.
- Late payment: retain observation and request seller review; never silently discard funds.
- Missing/invalid attribution: review queue, no guessed order match.
- Stale scanner: show verification unavailable and hold new release decisions.
- Storage failure after payment: preserve paid status, retry and show a delivery problem.

Manual support/refunds are outside automatic settlement. Do not invent a refund address from a shielded transaction or send refunds without an authenticated process.

## 6. Security and privacy boundaries

Seller sees product and invoice relationship and controls delivery. This is not atomic fair exchange. A malicious seller can withhold a key or sell incorrect content.

Messaging peers may observe network and routing metadata. Storage/gateway operators can observe identifiers and access patterns. Logos documentation does not establish fully anonymous file sharing as a current blanket guarantee.

The app origin can serve malicious JavaScript; CSP reduces some risks but cannot protect against a malicious origin. Extensions, compromised endpoints and shared unlocked browsers remain threats. Browser storage is not a secure hardware vault.

Use authenticated file encryption and validate a seller-authenticated manifest/digest before exposing plaintext. Select a maintained implementation; do not specify cryptographic parameters without library compatibility testing. Bound supported product sizes for browser memory safety based on measured behavior. Streaming support is a gate if whole-file decryption is unsuitable.

Buyer possession of a delivery key cannot prevent redistribution. No DRM claim.

Protect seller backups, viewing capability, product keys and database. Keep secrets outside the repository. Support merchant data/key backup before promising recovery after seller loss. Logs should contain minimal operational identifiers, not plaintext invoices, memo contents or buyer credentials.

## 7. Integration gates before application commitment

### Gate A: browser messaging and credentials

Prove authenticated encrypted browser-to-seller exchange through real Logos infrastructure, reconnect behavior and credential persistence/export compatibility. Secure WebSocket support alone is insufficient evidence.

### Gate B: storage delivery

Publish ciphertext, replicate to an independent node, retrieve through a constrained gateway, decrypt in a browser and verify integrity. Stop the original node and repeat retrieval. Measure supported file size behavior.

### Gate C: payment scanner and attribution

Choose a compatible testnet wallet/backend. Prove request handoff, shielded receipt scanning, deterministic invoice attribution, output deduplication, confirmation calculation and scanner-health reporting without giving the fulfillment service spending authority.

### Gate D: durable recovery

Restart seller service between confirmation and delivery; close and reopen buyer browser; recover without another payment. Demonstrate retries without unauthorized release. Exercise chain-state changes in deterministic tests and clearly distinguish them from public-testnet observations.

A failed gate requires revising the design. Do not silently replace Logos with ordinary HTTP messages or label simulated payment events as a real integration.

## 8. Tests and acceptance

### Deterministic tests

- Invoice binding, network checks and integer-amount parsing.
- Duplicate order requests and payment-output uniqueness.
- Exact/under/over/late/duplicate payment policies.
- Reordered message handling and replay rejection.
- Transactional outbox behavior at crash boundaries.
- Payment reorganization before and after delivery.
- Order-ID-only access rejection and wrong-buyer credential rejection.
- Corrupt ciphertext, mismatched manifest and unsupported file format rejection.
- Strict gateway path/identifier validation and rate/size limits.

### Browser tests

- No registration/email in the ordinary flow.
- Successful IndexedDB persistence before wallet handoff.
- Storage failure blocks unsafe checkout.
- Close/reopen recovery on the same origin/profile.
- Optional backup export/import into a fresh browser context.
- Clearing local data without a backup has an honest unrecoverable state.
- No credential-bearing URLs and no third-party checkout requests.

### Real integration demonstration

Real Logos messaging and storage, a real shielded Zcash testnet payment, successful local decryption, seller restart recovery and original-storage-node-offline retrieval. Record dependency versions and distinguish real, fixture-backed and simulated components in the demo report.

Performance measurement covers payment scan lag, fulfillment delay after confirmation, retrieval throughput, reconnect time and resource use. No unsupported throughput or production-readiness claims.

## 9. Planning sequence

1. Resolve integration gates and pin supported packages/backends.
2. Define application interfaces and persistent schema from observed APIs.
3. Implement durable order/payment/fulfillment core with deterministic tests.
4. Build buyer UX and local recovery against explicitly labelled test adapters.
5. Integrate real Logos and Zcash adapters; remove test bypasses from demo configuration.
6. Run browser, security-boundary and failure-recovery tests.
7. Produce repeatable setup, demo and limitation documentation.

This sequence is a design-level outline. The detailed build plan follows review of this document; it must identify actual dependency APIs rather than invent them.

## Sources and related files

- Research: ../README.md
- Decisions: design-decisions.md
- Logos browser transport: https://docs.logos.co/messaging/concepts/transports
- Messaging behavior and privacy: https://docs.logos.co/messaging
- Storage persistence and privacy: https://docs.logos.co/storage
- Storage module APIs: https://logos-co.github.io/logos-storage-module/latest/api_reference.html
- Payment request standard: https://zips.z.cash/zip-0321
- Zcash wallet read APIs: https://docs.rs/zcash_client_backend/latest/zcash_client_backend/data_api/trait.WalletRead.html
