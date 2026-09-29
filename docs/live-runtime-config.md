# Live runtime configuration (real-demo)

This page describes how the seller runs against the live local stack
(`SSF_MODE=real-demo`). The key list comes from `loadConfig` and `parseLive` in
`src/config.ts`. If this page and the code disagree, the code wins.

Every value below is a **placeholder**. Never paste a real token, viewing key,
scanner config, private key or peer ID into this file, into shell history or
into command arguments.

## Where values come from

- **live.env**: `.runtime/live/live.env`, written by `npm run infra:up`. It holds
  only non-secret wiring (socket paths, account ID, node dirs, peers, topic).
- **caller**: you (or `start:live`) set it in the environment.
- **0600 file**: a path in the environment that points at an owner-only file
  (mode `0600`). The seller refuses the file if group or other can access it.

## Keys real-demo reads

| Key | Required | Source | Meaning |
|---|---|---|---|
| `SSF_MODE` | required | caller | Must be `real-demo`. |
| `SSF_NETWORK` | required | caller | `regtest` for the local stack (`test` is also accepted). `mainnet` is rejected. |
| `SSF_ADAPTER_MESSAGING`, `SSF_ADAPTER_STORAGE`, `SSF_ADAPTER_SCANNER` | required | caller | Each must be `real`. Anything else is rejected in real-demo. |
| `SSF_MAX_HEALTH_AGE_MS` | required | caller | At most `120000`. |
| `SSF_MAX_CIPHERTEXT_BYTES` | required | caller | `73` in the first release. |
| `SSF_MAX_PLAINTEXT_BYTES` | required | caller | `41` in the first release. |
| `SSF_INVOICE_TTL_MS` | required | caller | Invoice lifetime in ms. |
| `SSF_DB_PATH` | required | caller | SQLite path. Default decision: `.runtime/live/seller/seller.sqlite` in a `0700` dir. |
| `SSF_ADMIN_TOKEN_FILE` | required | 0600 file | Absolute path to the admin token. Default decision: `.runtime/live/seller/admin.token`. |
| `SSF_SCANNER_CONFIG` | required | 0600 file | Absolute path to the scanner's `scanner.json`. Default decision: `SCANNER_JSON` from `scripts/live-infra/paths.ts`. The seller derives chain identity and the consensus fingerprint from it. |
| `SSF_SCANNER_SOCKET` | required | live.env | Absolute Unix socket path, at most 100 bytes. |
| `SSF_SCANNER_ACCOUNT_ID` | required | live.env | Scanner account the seller pins. |
| `SSF_WAKU_CONTENT_TOPIC` | required | live.env | For example `/ssf/1/<app>/proto`. |
| `WAKU_BOOTSTRAP_PEERS` | required | live.env | Comma-separated wss multiaddrs, such as `/ip4/127.0.0.1/tcp/<port>/wss/p2p/<peer-id>`. |
| `LOGOSCTL` | required | live.env | Absolute path to `logosctl`. |
| `LOGOS_NODE_A` | required | live.env | Absolute config dir of the origin storage node. |
| `LOGOS_NODE_B` | required | live.env | Absolute config dir of the replica storage node. |
| `SSF_WAKU_PEER_TIMEOUT_MS` | optional | caller | Waku peer wait. Has a built-in default. |
| `SSF_SELLER_PUBLIC_KEY` | optional | caller | 130-hex seller public key pin. If set, it must match the persisted seller identity. |
| `SSF_MIN_CONFIRMATIONS` | optional | caller | Defaults to `10`. Must be a positive integer. |
| `SSF_PUBLIC_HOST` / `SSF_PUBLIC_PORT` | optional | caller | Default `127.0.0.1:8787`. |
| `SSF_ADMIN_HOST` / `SSF_ADMIN_PORT` | optional | caller | Default `127.0.0.1:8788`. Keep the admin bind on loopback. |

`live.env` also carries `SSF_SCANNER_SOURCE_ID`, `THS_ENV_NAME` and
`APPIMAGE_EXTRACT_AND_RUN`. These are for the infra scripts. The seller config
does not read them. `SSF_DESTINATION` is not used in real-demo, because live
invoices use unique receivers allocated by the scanner.

## Keys rejected in real-demo

- **`SSF_ADMIN_TOKEN`** (an inline token) is rejected. An environment variable
  leaks through `ps`, `/proc/<pid>/environ`, shell history and child processes.
  Use `SSF_ADMIN_TOKEN_FILE` instead.
- **`SSF_SELLER_KEY_ID`** is rejected. The seller identity persisted in the
  database is authoritative. Pin it with `SSF_SELLER_PUBLIC_KEY` if you want a
  check.
- **Any `*CONSENSUS_FINGERPRINT*` or `*CONSENSUS_DIGEST*` key** is rejected. The
  consensus fingerprint is always derived from the activation schedule in
  `SSF_SCANNER_CONFIG`. A raw digest could silently pin the wrong chain.
- A fixture adapter value (`SSF_ADAPTER_*` other than `real`) is rejected.

## Start sequence

```sh
npm run infra:up                       # zcash regtest, scanner, logos-a/b, waku; writes .runtime/live/live.env
SSF_STRICT_LIVE=1 npm run infra:doctor # all 6 rows must pass
npm run build
npm run start:live                     # seller only; loads live.env plus the default paths above
# then, in another shell, publish a product (see below)
```

To publish a product through the seller's private admin route, run:

```sh
SSF_ADMIN_TOKEN_FILE=.runtime/live/seller/admin.token \
node --experimental-strip-types scripts/publish-live.ts \
  --admin-url http://127.0.0.1:<admin-port> \
  --plaintext-file <path-to-plaintext-at-most-41-bytes> \
  --version <product-version> \
  --amount-zat <integer-zatoshis> \
  --description "<text>"
```

`publish-live` has no token flag. It reads the token from the `0600` file, so
the token never appears in argv. It accepts only a loopback admin URL
(`127.0.0.1`, `localhost` or `[::1]`) and refuses plaintext over 41 bytes before
it sends anything. It prints only one of these:

- `published version=<v> cid=<first 12 chars>… replica=ok`
- `publish failed: <status> <error>`

The route (`POST /admin/products`) runs inside the seller process. It uses the
existing `publishProduct` API with the seller's own key store and live storage.
It returns these statuses:

| Status | Meaning |
|---|---|
| 201 | Published. |
| 400 | Invalid version, amount, description or payload. |
| 409 | That version is already published. Versions are immutable. |
| 413 | The plaintext or the body is too large. |
| 503 | `replica unavailable`: storage is down or the replica check failed. The product is not published. |

There is no built-in product fixture in real-demo.

## Startup lines

The seller prints only these lines:

- `public <url>`: the public (buyer) HTTP bind.
- `admin <url>`: the private admin bind. It needs `Authorization: Bearer <token>`.
- `ready scanner=<bool> messaging=<bool> checkout=<bool> products=<n>`: the
  result of the first bounded readiness refresh. `products` counts published
  products that have a readiness entry. `checkout=false` right after start is
  normal until the scanner, Waku and at least one product replica check pass.
- `startup failed: <ErrorName>`: startup unwound and the process exits non-zero.
  The usual cause is a missing live key (`MissingLiveKeyError`) or a config
  rejection. Check this page against your environment.

Operational logs are JSON lines with allow-listed fields only (`event`, `ok`,
`code`, `component`, `loop`, `count`, ...). They never contain secrets, CIDs,
descriptions or plaintext.

## Per-product readiness and TTL

A background readiness loop runs every `loopIntervalMs × 5` (10 s by default).
It probes the scanner and Waku, and checks each published product's replica. The
results are cached per product with a TTL (3 × the readiness interval by
default, about 30 s). Request paths read only the cache. They never download
from storage. If a product's entry is missing, failed or older than the TTL,
that product is treated as not ready, and new checkouts for it are refused.
Until the first refresh completes, `/api/availability` reports `scanner: false`.

## "verification unavailable" for a buyer

If the scanner cannot be reached when a buyer asks for a release, the seller
answers `503 {"error":"verification unavailable"}`. The buyer's payment is not
lost and nothing is released. The seller could not verify the payment right now.
Order status still answers, with verification marked `unavailable`. The buyer
should retry later. The same order is released once the scanner is back and the
payment has the required confirmations.

## Shutdown

Ctrl-C (SIGINT) or SIGTERM stops **only the seller**. It stops the loops,
closes the binds and closes the database. The live stack keeps running. Stopping
the stack is a separate, deliberate step:

```sh
npm run infra:down
```

## public-testnet keys

`SSF_MODE=public-testnet` reads these keys. It also reads the same live scanner, Waku and Logos keys as real-demo (`SSF_SCANNER_SOCKET`, `SSF_SCANNER_ACCOUNT_ID`, `SSF_SCANNER_CONFIG`, `SSF_WAKU_CONTENT_TOPIC`, `SSF_WAKU_PEER_TIMEOUT_MS`, `WAKU_BOOTSTRAP_PEERS`, `LOGOSCTL`, `LOGOS_NODE_A`, `LOGOS_NODE_B`, `SSF_SELLER_PUBLIC_KEY`) and the shared seller keys (`SSF_DB_PATH`, `SSF_INVOICE_TTL_MS`, bind host/port, `SSF_ADAPTER_*` = `real`). Inline `SSF_ADMIN_TOKEN` is rejected. `SSF_MAX_CIPHERTEXT_BYTES` is not free-set: the ciphertext cap is the plaintext cap plus 32. No bootstrap peer is added when the Waku cluster keys are absent.

| Key | Required | Meaning |
|---|---|---|
| `SSF_MODE` | required | Must be `public-testnet`. |
| `SSF_NETWORK` | required | Must be `test`. `regtest` and `main`/`mainnet` are rejected. |
| `SSF_PUBLIC_ORIGIN` | required | `https://<host>` with no path. This deployment uses `https://store.agentmascot.app`. |
| `SSF_MAX_PLAINTEXT_BYTES` | required | At most `8388608` (8 MiB). |
| `SSF_MIN_CONFIRMATIONS` | optional | Defaults to `10`. Must be at least `3`. |
| `SSF_MAX_HEALTH_AGE_MS` | required | At most `300000`. |
| `SSF_EMBED_ORIGINS` | required | Comma-separated `https://` origins, or the literal `*`. |
| `SSF_WAKU_CLUSTER_ID` | optional | Integer. Set only together with `SSF_WAKU_SHARDS`. Absent means no `live.waku.network`. |
| `SSF_WAKU_SHARDS` | optional | Comma-separated integers. Set only together with `SSF_WAKU_CLUSTER_ID`. |
| `SSF_MAX_OPEN_INVOICES_PER_BUYER` | optional | Defaults to `3`. Applies in every mode. |
| `SSF_MAX_INVOICES_PER_MINUTE` | optional | Defaults to `30`. Applies in every mode. |
| `SSF_ADMIN_TOKEN_FILE` | required | Absolute path to a `0600` admin token file. |
| `SSF_SCANNER_SOCKET` | required | Absolute Unix socket path, at most 100 bytes. |
| `SSF_SCANNER_ACCOUNT_ID` | required | Scanner account the seller pins. |
| `SSF_SCANNER_CONFIG` | required | `0600` `scanner.json` whose `chain.network` is `test`. |
| `SSF_WAKU_CONTENT_TOPIC` | required | Waku content topic. |
| `SSF_WAKU_PEER_TIMEOUT_MS` | optional | Waku peer wait. Has a built-in default. |
| `WAKU_BOOTSTRAP_PEERS` | required | Comma-separated wss multiaddrs already in the environment. |
