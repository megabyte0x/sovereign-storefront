# MVP design decisions

## Approved

- **Browser-first buyer experience.** The user explicitly selected browser-first over a native Logos/Basecamp client.
- **Automatic same-browser recovery.** Save purchase-specific credentials and minimal purchase metadata in IndexedDB. Returning buyers resume through My purchases without downloading or importing a file.
- **Optional portable backup.** Offer Back up purchases after checkout and from My purchases; no mandatory file download in the normal flow. Treat exported recovery material as sensitive.
- **Storage gate before payment.** Wait for the IndexedDB write transaction to complete and read back the required record before showing a payment request. This verifies current storage, not permanent retention. If unavailable, offer an explicit manual-backup fallback or stop checkout rather than silently proceed without recovery.
- **Honest persistence limits.** Request persistent storage where supported without treating a grant as a guarantee. Explain origin/profile isolation, private browsing, site-data deletion and device loss. Loss of both local credentials and backup means no guaranteed recovery.
- **Minimal browser exposure.** No third-party analytics or scripts on checkout/purchase pages. Local storage is not protection against malicious same-origin JavaScript, compromised extensions or access to an unlocked browser.

- **Buyer flow approved.** Product, Checkout, Purchase status and My purchases; payment and delivery states remain separate. Recovery requires buyer credentials rather than an order ID alone.

## Approved design

The user approved [mvp-design.md](mvp-design.md), including architecture, data model, exception policies, integration gates and acceptance tests. See [mvp-build-plan.md](mvp-build-plan.md) for the dependency-ordered implementation plan. Integration-specific choices still require executed probes.

## Approved architecture

- One seller per self-hostable deployment; no multi-tenant platform in the MVP.
- One-time digital downloads, fixed ZEC prices, Zcash testnet only.
- Browser buyer application and a separate seller-controlled fulfillment service.
- Buyer authorizes payment in an existing compatible Zcash wallet; no spending keys in checkout.
- Logos Messaging carries encrypted order and fulfillment messages. Prove the browser integration before selecting a package or committing to an encryption/session design.
- A narrowly scoped HTTPS ciphertext gateway connects browsers to Logos Storage nodes; no general-purpose node administration exposed to the browser.
- Browser performs file decryption. Gateway can observe IP addresses, requested content identifiers, sizes and timing; it must not receive decryption keys.
- Seller-controlled payment scanner provides settlement evidence; screenshots, client assertions and transaction IDs alone do not authorize delivery.
- Durable order state and retryable fulfillment; buyer-held recovery material supports recovery without email.
- Keep merchant administration private/local for the MVP; public storefront does not expose management endpoints.
- Separate payment status from delivery status to support retries and chain reorganizations without pretending released keys can be revoked.

## Integration gates

1. Browser-to-seller encrypted message exchange through real Logos infrastructure, with authenticated seller identity and a selected supported encryption library. Secure WebSocket support alone does not prove Chat/library compatibility.
2. Browser retrieval of ciphertext from Logos Storage through a restricted gateway and successful local decryption; verify independent replica retrieval.
3. Supported Zcash wallet payment request handoff and seller-side scanning of a real shielded testnet payment, including invoice attribution and confirmation handling.
4. Durable restart/recovery demonstration with no payment bypass or simulated success.

If a gate fails, revise the design explicitly. Do not silently replace Logos with ordinary HTTP or real settlement with mock events while claiming an integrated MVP.

## Documentation evidence

- Logos Delivery recommends secure WebSocket for browser environments: https://docs.logos.co/messaging/concepts/transports
- The Storage module documents native upload/download APIs and asynchronous completion events. This does not by itself establish a browser-native storage SDK: https://logos-co.github.io/logos-storage-module/latest/api_reference.html

## Implementation status

The design is approved and the build plan is written. No application scaffold, dependency installation, integration test or implementation has been performed. Exact adapter/library choices remain subject to the mandatory integration gates.
