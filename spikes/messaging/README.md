# Messaging spike

Gate A probe: browser buyer → real Logos Delivery (Waku) network → seller, with authenticated ECIES payloads and exportable recovery material.

## Selected implementation

Followed [Logos Messaging](https://docs.logos.co/messaging) and [browser transports](https://docs.logos.co/messaging/concepts/transports) (secure WebSocket) into the published JS packages from [logos-delivery-js](https://github.com/logos-messaging/logos-delivery-js) (`js-waku`).

| Package | Pin | Official exports used |
|---|---|---|
| `@waku/sdk` | `0.0.36` | `createLightNode`, `Protocols`, `DefaultNetworkConfig`, unencrypted `createEncoder` (negative control only) |
| `@waku/message-encryption` | `0.0.38` | `generatePrivateKey`, `getPublicKey`; `./ecies` `createEncoder` / `createDecoder`; `DecodedMessage.verifySignature` |
| `@waku/utils` | `0.0.27` | `createRoutingInfo`; `./bytes` `bytesToHex`, `hexToBytes`, `utf8ToBytes` |

License of those packages: MIT OR Apache-2.0.

Docs used:

- https://docs.waku.org/build/javascript/
- https://docs.waku.org/build/javascript/light-send-receive
- https://docs.waku.org/build/javascript/message-encryption
- https://docs.waku.org/build/javascript/run-waku-nodejs
- https://rfc.vac.dev/spec/26/ (Waku payload encryption)
- https://github.com/logos-messaging/logos-chat (Chat library)

Security notes recorded from those docs:

- Delivery applies libp2p Noise on the connection. Application payloads are **not** encrypted unless a payload codec such as `@waku/message-encryption` is used.
- Filter / Light Push / Store disclose content topics to serving peers.
- `@waku/sdk` is designed for browsers over secure WebSocket. Node.js works with limitations; this probe used it only for the seller process and for the live Node↔Node check.
- Official key persistence example stores keys with Subtle Crypto + local storage and documents hex round-trip via `@waku/utils/bytes`. This probe persists in IndexedDB (design requirement) and exports hex JSON.

## Chat / session library

**`logos-chat` is not a browser library.** It is a Rust workspace (`0.1.0`, pre-1.0) with SQLCipher on-disk storage, an embedded native delivery node, and no published WASM/JS session SDK.

This probe does **not** invent a Noise/MLS session. Seller authentication is the documented Waku Message v1 path: ECIES to the recipient public key plus ECDSA signature (`sigPrivKey` / `verifySignature`).

Credential export **does** work for this store: `exportRecoveryMaterial` returns a JSON string containing `privateKeyHex` / `publicKeyHex` produced by `@waku/utils/bytes`. That material restores possession in a fresh browser profile. Treat it as a secret. It is not a logos-chat account backup.

## What was proven

1. Wrong seller signature is rejected. Light Push `{successes,failures}` acks and unencrypted version-0 payloads are not accepted as application responses.
2. Browser (Playwright + system Chromium) encrypts an order request, Light Push delivers it onto The Waku Network (`clusterId: 1`), the seller Filter subscription decrypts it, and the buyer accepts only a seller-signed `order-response`.
3. IndexedDB credentials survive closing the persistent browser profile and reopening it. Exported recovery JSON restores possession in a fresh profile.
4. Interrupting the buyer transport, reconnecting, and resending the same `requestId` yields one logical `responseId`.
5. Incorrect authorization is rejected. Replaying a spent authorization on a new `requestId` is rejected.
6. Synthetic markers `ORDER_MARK`, `BUYER_MARK`, `PRODUCT_MARK` live only in the encrypted JSON body. Public content topics use `/ssf-probe/1/<runId>/proto`. Inspection of unencrypted envelope fields (`contentTopic`, `pubsubTopic`, `version`, `timestamp`, `ephemeral`, `meta`, `rateLimitProof`) found no markers.

Observed live-network round trip (Node buyer/seller over the same public network): Light Push successes `2`, application latency ~2.8s after both nodes were subscribed. Browser e2e encrypted exchange + reconnect passed in ~43s wall time including bootstrap.

## Rerun

From `spikes/messaging` with Node ≥ 22:

```sh
npm ci
npx playwright install chromium   # optional; e2e uses /usr/bin/chromium when present
npm test                          # unit tests, no network
npm run test:live                 # real Logos Light Push + Filter exchange
npm run test:e2e                  # browser IndexedDB + browser→Logos→seller
```

Playwright launches `/usr/bin/chromium` (`--no-sandbox`). Official Playwright Chromium download for this OS/arch was unreliable in the probe environment.

Runtime secrets belong under ignored `spikes/messaging/data/` (mode `0700`). Do not copy keys, invoices, payment URIs, or memos into `spikes/results/`.

## Concerns

- No Logos Chat browser session SDK. Encryption/auth is Waku payload encryption, not de-MLS Chat.
- `@waku/sdk` `isConnected()` / `health` can report `Unhealthy` while Light Push/Filter against a bootstrap peer still succeed.
- Filter may deliver the same payload more than once; fulfillment is idempotent on `requestId`.
- GitHub `logos-delivery-js` is ahead of npm (`@waku/sdk` `0.0.37` unpublished). This probe pins the latest npm release `0.0.36`.
