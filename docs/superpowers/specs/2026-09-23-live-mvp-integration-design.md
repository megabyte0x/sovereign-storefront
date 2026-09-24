# Live MVP integration design

Status: design selected under the user's instruction to choose the best approach and create the implementation plan. This authorizes planning, not implementation, commits, transactions, or deployment. No new live qualification was performed while writing this document.

Baseline: `96700329ad782e49875b714d9536e97a7d93fdd8`. Read together with `docs/mvp-design.md` and `docs/zakura-reuse-analysis.md`. This addendum supersedes earlier shared-address/memo assumptions for NEW live invoices, not the immutable terms of existing purchases.

## 1. Decision and evidence

Use a standalone viewing-only Rust scanner built from the published, renamed Zakura wallet packages. The wallet-libraries consumer instructions explicitly recommend direct package dependencies for applications using only one stack, rather than the dual-backend selector or an upstream/Zakura mixture:

https://github.com/zakura-core/wallet-libraries/blob/869a98221030e021d75384fc9b4ace18d1d52a86/README.md#consume-from-a-wallet

Candidate packages are `zakura-client-backend = 0.1.0-rc5` and `zakura-client-sqlite = 0.1.0-rc5`, keeping their upstream Rust import aliases. Their resolved compatible `zakura-*` crypto dependencies supply common's primitives. Do not add the parallel `librustzcash` wallet family, a prover, a spending service, or the dual-backend selector without an actual application requirement.

Allocate one external Orchard shielded receiver per invoice using persisted wallet address APIs. Issue an Orchard-only Unified Address; no transparent fallback. Match the receiver bytes recovered from actual owned notes, not the serialized UA string, payer claims, memo echoes, or amount. A different UA can encode the same receiver.

This attribution choice is OUR application design using repository capabilities; the repositories do not prescribe storefront invoicing. It removes mandatory memo preservation and lets a local arbitrary-address faucet serve as a payer without being trusted as a scanner.

Alternatives rejected for this MVP:

- Shared UA plus mandatory invoice memo: technically valid with independently decrypted memos, but adds an avoidable payer requirement and does not reduce scanner correctness work.
- ths activity/dashboard adapter: quick local imitation, but not a production payment authority and not sufficient received-note evidence.
- Combining all repository HEADs: risks incompatible protocol types and unsupported upgrade/RPC combinations.

Use Zakura as a separate node behind compatible lightwalletd. Stable `v1.4.0` is a qualification candidate, not a proven compatible deployment. For local evidence, record the actual node/lightwalletd images supplied by the chosen ths environment; do not claim they are v1.4.0 merely because that is the public-network candidate. Keep historical transaction access for enhancement and rescan; archive node storage is the simplest initial choice.

## 2. Scope and honest release labels

### L — local end-to-end MVP target

One seller, one small encrypted product, actual Waku browser/seller traffic, independently scanned shielded regtest payment, ten confirmations, durable seller/browser recovery, two independent local Logos nodes, origin-stop replica retrieval, and browser decryption of the exact published plaintext.

The existing first-release limits remain 41-byte plaintext and 73-byte ciphertext. This is an integration demonstrator, not a useful-size digital-download deployment. Reject larger uploads; do not silently raise the limit.

ths is permitted ONLY in development setup and payer/mining orchestration. The same scanner service must connect directly to lightwalletd with an imported seller UFVK. No ths imports or activity calls in `src/` or the scanner service. Scanner receipt APIs must have no method for accepting a payer-submitted receipt.

### T — public-testnet qualification

A separate acceptance gate: the same scanner against qualified public-testnet node/lightwalletd, a real external wallet consuming the generated ZIP-321 URI/QR, correct receiver/amount, confirmations, Waku fulfillment, and browser download. Local regtest evidence does not satisfy this gate. No mainnet support is enabled by this plan.

Public Logos deployment, useful-size file support, mainnet safety/operations review, automatic refunds, and wallet product development remain outside this implementation slice. Failure to finish L is not permission to declare fixtures a working live MVP. Passing L is not permission to declare T or production ready.

## 3. Components and authority

    External spending wallet (separate secret boundary)
              | shielded payment
    Zakura node -> lightwalletd -> viewing-only Rust scanner
                                      | private Unix socket
    Browser <---- authenticated Waku ----> TypeScript seller
       |                                    | encrypted publication
       +-- restricted ciphertext gateway <-- Logos replica B
                                                  ^
                                           Logos origin A

- Scanner: UFVK, birthday/chain parameters, wallet SQLite, allocation journal, incoming-note projection, reconciled snapshots. No seed/spending key or payment-send API.
- Seller: invoices, product keys, identity, receipt snapshots, release policy, delivery outbox. No wallet spending authority.
- Browser: per-purchase credentials in IndexedDB, seller-pinned Waku requests, validated invoices, optional bearer-sensitive backup, decryption. No seller viewing keys.
- Local test payer: separately generates/holds disposable spending material and may invoke ths faucet/mining. Only public allocation/payment results enter sanitized reports; chain receiver evidence comes from the scanner.

Use a mode-0600 Unix-domain socket in a mode-0700 directory. The scanner and seller can share an OS account in the local MVP. This protects against other local users, not a compromised same-user process. Remote scanner access/mTLS is not needed for L. Public lightwalletd connections require validated TLS; explicitly configured loopback regtest may use plaintext gRPC.

## 4. Invoice allocation across two databases

1. Authenticate buyer request and persist request ID, buyer public key, immutable product version, amount, network, invoice ID, created time and expiry BEFORE scanner allocation.
2. Use that invoice ID as `allocationId`; reserve the next diversifier index in the scanner application database before wallet derivation. Never derive from a hash of an order ID.
3. Derive/persist the address with the wallet API at the reserved index. Store account, external scope, pool, index and exact receiver bytes. Retry the same allocation/index after crash; burn abandoned allocations rather than reuse them.
4. Persist the receiver allocation and library-generated ZIP-321 URI into the seller invoice before replying. New issuance fails closed on dependency unavailability; replay of an already-issued invoice does not require allocating again.
5. Reject changed terms for an existing allocation. Equal-price invoices must have different receiver identities. Keep expired allocations indefinitely for the supported retention period; do not recycle them.

Migration preserves v1 memo invoices and delivery packages as legacy records. Do not relabel old `network='test'` rows as regtest based on a prefix. A fresh live database is the default. A legacy database cannot become live without an explicit checked migration; old unpaid memo invoices require manual resolution, not receiver-based automatic settlement.

## 5. Scanner receipt contract and release policy

Return bounded, complete receipt snapshots rather than a height-filtered event stream. For this single-seller MVP, full snapshots avoid an additional change-log retention protocol. A complete snapshot covers every incoming output known since the imported account birthday, including spent and noncanonical outputs; maximum 10,000 records and 16 MiB encoded body. Exceeding either is an unavailable state, never truncated success.

Each snapshot binds source ID, monotonically increasing persisted generation, exact network/genesis hash/consensus fingerprint (v1 canonical activation-schedule digest, defined in the plan's Section 3.1b), account ID, tip height/hash, fully scanned height/hash, health, observation times, completeness, and receipt set. Advance the generation even on a lower-height rewind or same-height fork. An independently fresh health response must NEVER authorize stale observations.

Receipt identity is chain + txid + pool + output/action index, derived from actual wallet data. Amount is a canonical integer-zatoshi string. Include external/internal scope, account, receiver bytes, mining height/hash and canonicality. Incoming external receipts only are eligible; exclude change, sent-only rows, unsupported pools and foreign accounts. Spent receipts remain payment history.

`sync::run` is not the whole scanner: supply its block cache, transaction enhancement/status worker and persistent history projection. Keep any wallet-SQL view coupling isolated and version-tested in Rust. If mandatory subtree/upgrade RPC calls are unsupported, stop qualification rather than swallow the error or synthesize a successful response.

Publish `caughtUp=true` only after scan/enhancement work required for the projection is complete and local/remote tip identity agrees. Re-read the remote tip after the coherent wallet read; retry on a changing/forked tip. This is bounded evidence, not a guarantee against a future chain reorganization.

The seller commits a whole validated snapshot, all affected settlements, revocations, and its checkpoint atomically. Persist/check generation order, not block-height order. A missing formerly observed output in an explicitly complete replacement snapshot becomes noncanonical, not still payable. Reject partial snapshots, backward generation, source changes, wrong chain/account and future timestamps. A scanner restore needs an explicit generation/source reset procedure and a full rescan barrier; never silently accept generation rollback.

First release requires all of:

- Correct network, chain and receiving account.
- Exact invoice receiver match in external Orchard scope.
- A single canonical output meeting or exceeding the invoice amount.
- At least ten confirmations under the same reconciled tip/hash.
- A complete caught-up snapshot checked within 120,000 ms, not in the future.
- Receipt first independently observed by scanner no later than invoice expiry.

For the last rule, preserve the earliest scanner `firstSeenAt` across restart/reorg. If scanner downtime means a receipt is first discovered after expiry, route to late-payment review even if a block timestamp suggests an earlier payment. This conservative policy is explicit; do not substitute payer time or mutable block timestamps.

Retain the existing no-partial-aggregation rule. Underpayment requires review; overpayment may fulfill once with excess flagged; duplicate sufficient outputs buy no second entitlement; late/unmatched receipts require review. Reorg before first disclosure blocks release; reorg after disclosure records an exception and cannot revoke a key.

## 6. Authenticated Waku protocol and recovery

Promote Gate A's proven SDK/encryption dependencies, not its test authorization shortcut. `@waku/sdk 0.0.36`, message-encryption `0.0.38`, and utils `0.0.27` are initial pins. Use the library's signed ECIES encoder/decoder, verify recovered signer on BOTH sides, and encrypt the complete application payload. Do not design new cryptography.

Use one application/deployment content topic, not per-order/product/buyer topics. Requests carry version, type, unpredictable message ID, persistent create-request ID when applicable, expected seller key, network, issue/expiry times and operation payload inside encryption. Responses bind message ID, operation and buyer. Bound plaintext to 32 KiB, outer wire bytes to 65,536, request lifetime to 120,000 ms, clock skew to 30,000 ms and retries to five with capped backoff. Reconnect resubscribes before sending; an exhausted request can be explicitly retried with a fresh message ID and the same checkout idempotency key.

Supported operations: create, status, recover, acknowledge; unsolicited delivery is also seller-signed and buyer-encrypted. Persist deduplication for mutating requests. A repeated identical request reuses committed terms; reused message IDs with changed payloads fail. Recovery reauthorizes current release state rather than blindly replaying a stale cached delivery response. Light Push acceptance is transport acceptance, never an authenticated application response or buyer receipt.

A persistent seller identity is loaded once, cryptographically checked against its public key, used by the actual Waku endpoint, and advertised in public configuration. A configured pin mismatch is fatal. Browser purchases retain the pinned seller identity; restore must retain it too. Add a public-key lookup to the credential adapter so normal messaging never exports a private backup just to obtain a public key.

First-send, explicit recovery and acknowledgement use the same fulfillment service. Prepare a sealed immutable package separately from disclosure. Persist a send intent before network I/O, then transport-accepted outcome or buyer acknowledgement. A prepared/queued/intent-only package is NOT automatically replay-authorized: absent durable transport acceptance or buyer acknowledgement, recheck fresh eligibility. A crash after a send but before outcome persistence is uncertain and must fail closed while verification is unavailable. Once transport acceptance or authenticated acknowledgement is durable, explicit recovery can resend the same package despite scanner outage, with any reorg exception retained. Periodic dispatch does not resend accepted packages every tick; explicit recovery bypasses the in-process suppression and returns the actual package.

Buyer acknowledgement is idempotent, authenticated and bound to package identity. Persist the original authenticated wire envelope and package locally before acknowledging; reverify seller signature and order/product/buyer/digest bindings on reload/import. Legacy unsigned cached packages require authenticated Waku recovery rather than being promoted to trusted evidence. Browser decryption failure remains distinct from successful package delivery.

In live mode disable HTTP create/status/recover/payment-override routes. HTTP remains for static assets, public configuration/catalogue, availability and the constrained ciphertext gateway. Admin remains loopback/private. No HTTP fallback when Waku fails.

## 7. Logos storage and browser behavior

Reuse the existing Logos adapter and encryption format. Publication connects/warm-replicates A to B, retrieves bytes from B and verifies digest/size before the product becomes purchasable. Request acceptance, manifest presence and non-empty partial files are not completion.

Replica reads must contact only B; remove the origin lookup/connect from `fetch`. Validate downloads against the published size/digest and correlate upload/download completion to the exact operation. Replace blocking subprocess calls on active request paths with bounded asynchronous calls so scan and Waku loops remain responsive. Require explicit runtime paths; remove hardcoded worktree/scratch discovery.

The origin-stop test publishes a NEW CID in the current run, proves B has it, stops only the run-owned origin, restarts the gateway/seller and uses a fresh browser context/imported backup. Retrieval must succeed from B without app/file/browser cache or origin contact. B's own persisted replica data is expected and is not an invalid cache substitute.

The browser keeps existing Product, Checkout, status and My purchases controls. It persists credentials/draft before create and verified immutable invoice before payment display. Store expected price/network with the draft and verify seller, buyer, product version, amount and network on response. Produce a real QR from the library-generated ZIP-321 URI; replace the static SVG. Round-trip decode the rendered QR in tests. Local regtest labels explain that external wallet support is not proven and the test payer uses the address directly.

Recovery must work through visible controls without `window.__ssf` hooks. Optional export/import remains bearer-sensitive; version its format, preserve legacy records without quietly changing seller/network/terms, and provide an honest storage-loss state. Update CSP with only configured Waku WebSocket peers, no wildcard network permissions or third-party scripts. Serve public deployments over HTTPS.

## 8. Operations, verification and exit conditions

Use explicit startup readiness for scanner, Waku subscription/peers and replica retrievability; probe per requested product, not merely the first published row. Unavailable dependencies block NEW checkout; paid purchases retain state and explain retries. Shut down timers, subscriptions, child processes and stores on failure or SIGTERM. Health logs must not include invoices, viewing keys, private keys, memos or sealed-package contents.

Back up seller database/product keys/identity plus scanner UFVK, birthday, wallet database and allocation journal under encryption. Stop both writers during the initial backup implementation. Restore into new private directories, invalidate old release freshness, catch up/rescan, compare allocation mappings and prove no address reuse or double entitlement. Spending-wallet backups are separate and excluded.

Release report must bind source revision + dirty-diff/build fingerprints to actual adapter instances and versions. Each required gate has PASS, FAIL or SKIP plus evidence; overall L succeeds only if all L gates PASS and `liveAttempted=true`. Missing dependencies or unsupported protocols produce nonzero strict-live execution and a reason, never a synthetic success. Deterministic reorg tests must not be described as a live fork experiment.

The implementation plan supplies exact task owners, files, contract changes and commands. The first scanner gate is the go/no-go for the same-day objective. A complete production-directed scanner may exceed the remaining day; do not trade away receipt verification, replay safety or honest evidence to meet the deadline.
