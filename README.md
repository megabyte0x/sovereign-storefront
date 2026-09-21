# Sovereign Storefront: private checkout and recoverable digital delivery

## Status

Research and product hypothesis; not an approved implementation plan.

The research inspected official documentation and competitor offerings. No end-to-end checkout, payment, storage failover, security audit, or scale benchmark has been executed. Customer demand, production readiness, and scale remain unvalidated.

## Recommendation

Build a seller-owned way to sell digital goods from anywhere—not a destination where everyone must list their products.

A creator keeps their website and audience. The product handles:

> Private order → shielded payment → encrypted delivery → recoverable purchase.

A simple storefront demonstrates the workflow. Embeddable checkout is a potential broader distribution path.

**Positioning:** private checkout and recoverable digital delivery, powered by Logos for communication and file distribution, and Zcash for shielded settlement.

**Starting point:** seller-owned checkout links, not a shared marketplace. This avoids requiring a new marketplace audience and lets pilot sellers bring existing buyers.

## 1. Existing alternatives and the possible opportunity

| Alternative | Documented functionality | Implication |
|---|---|---|
| BTCPay + Easy Digital Downloads | Bitcoin checkout for digital downloads, with completed-order updates after payment. The documented integration is not maintained by the BTCPay team. [8] | “Pay crypto and get a file” is not differentiation. |
| ZGo | Noncustodial shielded-ZEC payments, scanning, invoices, receipts, and WooCommerce integration. [10] | Another Zcash invoice generator is not the main product opportunity. |
| CipherPay for WooCommerce | Shielded payments, confirmation webhooks, and automatic order updates. Its disclosure also lists sending customer shipping name/address to its service. [12] | Private settlement does not automatically mean a private shopping workflow. |
| Shopstr Markets | Nostr-based commerce, Lightning/Cashu payments, encrypted messaging, and portable reviews. [9] | Sovereign commerce and private messaging are not unique either. |

The opportunity to validate is the combination: a useful buying experience with minimal personal-data collection, seller-controlled payment verification, and encrypted fulfillment.

This is not a proven market gap. The reviewed sources establish competing functionality, not uniqueness or demand for this specific combination. Do not assume the BTCPay digital-download integration is compatible with a Zcash plugin without testing.

## 2. Customer promise and first users

### Seller

> Sell from your existing site. Receive money directly. Keep control of your files and purchase records. Move providers without rebuilding your business.

### Buyer

> Buy without creating another platform account or giving a payment intermediary your identity and reading interests.

The seller still knows which product was purchased. The goal is to avoid unnecessarily exposing the purchase to other parties, not to conceal fulfillment details from the seller.

### Initial segment

Proposed first users: independent digital publishers and software creators whose customers already use ZEC.

This is a starting segment, not a permanent restriction. The underlying flow can serve books, software, educational downloads, design assets, and other digital goods.

Starting with everyone would require solving distribution, onboarding, currency conversion, and fulfillment simultaneously. Demand and willingness to pay remain hypotheses.

## 3. Proposed architecture

```text
Seller's website or shared product link
                   |
                   v
           Buyer checkout client
                   |
      Encrypted order via Logos Messaging
                   |
                   v
         Seller-controlled service
           |                  |
           |                  +-- Zcash wallet scanner
           |                      verifies incoming payment
           v
  Encrypted delivery key via Logos Messaging
           |
           v
Buyer retrieves encrypted file through Logos Storage
           |
           v
       Local decryption
```

No bridge, wrapped ZEC, LEZ payment token, or custom blockchain is required by this proposal.

### Logos contribution

Logos Messaging provides transport and an end-to-end encrypted Chat layer. Its Store protocol retains messages temporarily but does not guarantee availability. [2]

Logos Storage provides CID-based file distribution and replication. Its API exposes upload/download operations and completion events. [1][5]

Files must be encrypted before publication. A CID is not access control: anyone holding it can download the associated file. [1]

### Zcash contribution

Payment requests can use ZIP-321. Receipt must be verified separately: a URI is an instruction to a wallet, not evidence of payment. [3]

The Zcash client backend documents methods for reading transaction heights and note memos. These are foundations for an invoice scanner, not a complete commerce integration. [7]

The product work is connecting these components reliably. Evaluate existing payment integrations before building a new payment backend.

### Example purchase

1. Seller encrypts a product and publishes the ciphertext through Logos Storage.
2. Buyer requests an invoice through an encrypted conversation.
3. Seller returns a payment request bound to the product version and buyer delivery key.
4. Buyer authorizes a shielded payment in their wallet.
5. Seller-controlled service detects the payment and applies its confirmation policy.
6. Seller service releases the decryption key through encrypted messaging.
7. Buyer downloads and decrypts the product locally.

This is not trustless exchange. The buyer trusts the seller to deliver the advertised file. Removing that trust requires a substantially harder protocol.

## 4. Fulfillment is the hard problem

| Failure | Required behavior |
|---|---|
| Buyer pays, then closes the browser | Recover the purchase without requiring an email account. |
| Seller service restarts after payment | Reconcile from durable records and resume delivery. |
| Delivery message is lost | Retry safely and allow the buyer to request delivery again. |
| Payment arrives after invoice expiry | Apply an explicit late-payment policy. |
| Buyer underpays or pays twice | Route to a clear exception workflow. |
| Chain reorganization changes payment status | Reconcile payment state; a released key cannot be unreleased. |
| File is unavailable | Detect the problem and provide recovery or refund handling. |

### Proposed design requirements

- Bind each invoice to product version, amount, network, expiry policy, and buyer delivery key.
- Use a unique invoice identifier; do not match solely by amount.
- Keep durable payment and fulfillment records on the seller side.
- Make fulfillment idempotent: retries return the same entitlement rather than create inconsistent orders.
- Provide an exportable buyer recovery capability, with clear warnings about loss and sharing.
- Keep spending keys out of the fulfillment service where the selected wallet integration permits it.
- Treat read-only wallet access as privacy-sensitive: inability to spend does not imply inability to expose payment history.
- Do not treat a buyer-supplied transaction ID, a sent-payment message, or opening a wallet URI as settlement evidence.

The intended value is a dependable purchase without a platform account—not another encrypted messenger.

## 5. Ownership and trust boundaries

| Asset or function | Proposed controller |
|---|---|
| Funds | Seller's wallet |
| Product encryption keys | Seller |
| Buyer recovery material | Buyer |
| Order database | Seller |
| File replicas | Seller-selected nodes or providers |
| Public discovery | Optional websites/directories |
| Hosted support services | Replaceable providers |

A managed provider sees whatever the seller delegates to it. A deployment where the provider holds decryption keys and readable order records must not be advertised as opaque to that provider.

Hosted checkout also introduces trust in served JavaScript. A browser interface is not automatically as sovereign as a locally installed client.

### Deployment choices

- **Native client:** stronger local control, more installation friction.
- **Browser checkout:** easier distribution, additional trust in hosting and gateway infrastructure.

A native client may be reasonable for a Logos event demonstration. For broader adoption, browser feasibility is a go/no-go question rather than an assumed solved problem.

## 6. Scale: distinguish reach from capacity

### Market reach

The workflow applies across digital-product categories. This is plausible breadth, not proof buyers will switch.

The adoption barrier is whether buyers already have ZEC and find the privacy benefit worth additional payment steps. Currency acquisition, price volatility, and seller conversion needs can outweigh the benefit.

### Technical capacity

Proposed approach:

- Distribute encrypted product files independently of individual orders.
- Send small invoice and key-delivery messages rather than files over messaging.
- Isolate each merchant's wallet access, keys, and order state.
- Maintain deliberate replicas rather than rely on buyers to keep files available.
- Measure scanning lag, payment-to-delivery latency, retry behavior, and operating cost.

Logos explicitly states that organic replication does not guarantee persistence; replication groups are not currently provided out of the box. [1]

Messaging documentation describes a trade-off between shared content topics for privacy and topic buckets for distributing load. [2]

“Works at scale” is a benchmark target, not an established property of this proposed integration.

### No DRM promise

Once a buyer obtains plaintext, they can copy it. Encrypting a product once and distributing its key is efficient, but buyers can redistribute that key as well. Encryption protects distribution from unauthorized intermediaries; it does not guarantee control after purchase.

## 7. Privacy and readiness limits

- Storage documentation describes fully anonymous filesharing as a future-maturity property, not a present blanket guarantee. [1]
- Store and Filter messaging connections can associate a peer with queried topics. [2]
- The storage onboarding guide targets a testnet release. [6]
- Public listings, hosting logs, access timing, network observations, endpoints, wallet infrastructure, and cash-out can expose information.
- Seller-controlled fulfillment does not establish atomic fair exchange.
- Decentralized replication does not guarantee deletion, permanent availability, or immunity from legal obligations.

**Defensible claim:** minimize personal-data collection, encrypt order communication and delivery, and settle through shielded Zcash.

**Do not claim:** nobody can know what a buyer purchased, complete anonymity, guaranteed permanent hosting, production readiness, or trustless delivery.

## 8. Bounded MVP

**One-time paid downloads from seller-owned links.**

### Include

- Minimal product page.
- Encrypted upload and verified replica availability.
- Private invoice delivery.
- Real shielded testnet payment detection.
- Confirmed-payment-triggered key release.
- Purchase recovery after closing the client.
- Restart-safe fulfillment.

### Exclude

- Marketplace feed.
- Ratings and public reputation.
- Subscriptions or automatic wallet debits.
- Escrow or trustless-delivery claims.
- Fiat conversion.
- Physical goods.
- Automatic refunds requiring online spending authority.

### Demonstration

A buyer pays and disconnects before receiving the file. They later recover the purchase. The file remains downloadable after the original uploader goes offline because another participating node retains and serves it.

This demonstrates payment reconciliation, recoverable delivery, and independent file availability—not merely a successful checkout screen.

### Verification targets before stronger claims

- Real testnet payment rather than simulated payment status.
- Wrong amount, duplicate payment, missing reference, and late payment handling.
- Restart between payment detection and key delivery.
- Duplicate or reordered messages.
- Buyer recovery without email.
- File retrieval from an independent replica.
- Documented confirmation and chain-reorganization behavior.
- Explicitly documented information visible to every actor.

These are proposed acceptance criteria, not tests already passed.

## 9. Business model and validation

### Revenue hypothesis

Paid merchant operations:

- Managed seller instances.
- Replication and availability services.
- Backups and recovery.
- Storefront integrations.
- Support.

A mandatory percentage fee may be harder to justify when the promise is seller control and direct settlement. Pricing and unit economics are not established.

### Validation questions

1. **Problem:** can sellers describe a concrete privacy or platform-dependence problem?
2. **Distribution:** can they bring actual buyers without a new marketplace?
3. **Payment:** will those buyers use ZEC?
4. **Operations:** do sellers prefer this setup to existing checkout tools?
5. **Value:** will sellers pay for reliable operation rather than merely endorse the privacy story?

Existing integrations demonstrate supplier investment in crypto commerce, not profitable demand for this product. No merchant counts, revenue estimates, conversion rates, or willingness-to-pay claims have been established by this research.

### Kill or narrow conditions

- Sellers only want a Zcash payment button; existing products already cover much of that need.
- Buyers abandon checkout because obtaining ZEC is too difficult.
- Browser/native-client requirements make purchase completion impractical.
- Storage and messaging operations cost more than merchants will pay.
- Sellers gain no meaningful benefit over an existing self-hosted shop.

## 10. Next decision

Continue exploring **private checkout and recoverable digital delivery**, using a small storefront as its first interface.

Prefer seller-owned checkout links over a shared marketplace. Validate one merchant's real purchases and repeat use before expanding the product surface.

Research authorization is not implementation approval. No code or deployment is implied by this document.

## Sources

Source identifiers preserve the research ledger numbering; gaps are intentional.

[1] https://docs.logos.co/storage

[2] https://docs.logos.co/messaging

[3] https://zips.z.cash/zip-0321

[5] https://logos-co.github.io/logos-storage-module/latest/api_reference.html

[6] https://docs.logos.co/storage/get-started/run-logos-storage-node

[7] https://docs.rs/zcash_client_backend/latest/zcash_client_backend/data_api/trait.WalletRead.html

[8] https://docs.btcpayserver.org/EasyDigitalDownloads

[9] https://shopstrmarkets.com/faq

[10] https://zgo.cash

[12] https://wordpress.org/plugins/cipherpay-for-woocommerce
