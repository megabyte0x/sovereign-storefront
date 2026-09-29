# Task 3: Code wave (5 parallel subagents, same worktree, disjoint Owns)

Frozen contract for Wave 3: everything `2.1` produced (`src/contracts/public.ts`, the `public-testnet` config fields `publicOrigin`, `embed`, `maxCiphertextBytes`, and `profileFor`). Workers do not edit Task-2 files, `package.json` or the lockfile. A needed dependency is a `deviation` for the orchestrator to add serially before the wave, in step W3.0.

**W3.0 (orchestrator, before dispatch):** apply dependency deviations known from G2. Default: none. `@waku/sdk`, `qrcode` and `jsqr` already exist. Then run `npm ci`.

---

## 3.1 Scanner: Zcash testnet support (Rust)

- **Owns:** `services/scanner/src/{config.rs,consensus.rs,allocate.rs,daemon.rs,scan.rs,restore.rs,wallet.rs}`, `services/scanner/tests/testnet_config.rs` (new), `scripts/provision-scanner-runtime.ts`, `tests/unit/provision-scanner-runtime.test.ts`, `docs/scanner-qualification.md`. Timebox 3 h.
- **Consumes:** the 1.1 verdict (params choice). **Produces:** `scanner.json` with `runtime.chain.network: "test"`; CLI `init-view --network test --lightwalletd https://… --birthday <h>`; no API/protocol schema change (`services/scanner/protocol/schema.json` is untouched, since it already allows `"test"`).
- [ ] RED `services/scanner/tests/testnet_config.rs`:
  - `open_runtime_paths` accepts `network:"test"` with an `https://` lightwalletd and testnet activation heights, and rejects `network:"test"` with a plaintext non-loopback endpoint (already enforced by `validate_lightwalletd_endpoint`; assert that it stays enforced).
  - A UFVK with the `uviewtest` HRP decodes under test params. A `uviewregtest` key is rejected under test params, and the reverse also holds.
  - `consensus_fingerprint("test", heights)` is stable and differs from regtest's.
  - `allocate` produces a `utest1…` Orchard-only UA under test params.
- [ ] Implement: rename `decode_regtest_orchard_ufvk` to `decode_orchard_ufvk(params, network, ufvk)`; replace the `!= "regtest"` gate with an allowlist of `{"regtest","test"}`; build test params from the 1.1 choice (built-in `TestNetwork`, or `LocalNetwork` with public testnet activation heights hardcoded and cited from `zcash_protocol` constants). Regtest behaviour and all existing tests stay unchanged.
- [ ] Birthday: `init-view` fetches `GetTreeState(birthday-1)` over TLS and persists it as the existing `TrustedBirthdayTreeState`. The operator-attested flow is unchanged.
- [ ] `provision-scanner-runtime.ts`: accept `--network test` and write `scanner.json` 0600. Unit test for the argument path.
- **Verify:** `cd services/scanner && cargo fmt --check && cargo clippy --locked -- -D warnings && cargo test --locked`; `npx vitest run tests/unit/provision-scanner-runtime.test.ts`.
- **Blocked-exit:** if the pinned rc5 cannot express testnet params, stop with `blocked` and the exact compiler/API evidence. Do not bump crate versions.

## 3.2 Useful-size files: crypto cap, streaming gateway, storage transfer, browser download

- **Owns:** `src/adapters/crypto.ts`, `src/adapters/storage.ts`, `src/gateway/ciphertext.ts`, `src/browser/download.ts`, `tests/unit/crypto-size.test.ts` (new), `tests/unit/gateway-range.test.ts` (new), `tests/unit/logos-storage.test.ts`, `tests/unit/gateway.test.ts`. Timebox 3 h.
- **Produces:** `encryptProduct(plaintext, key, capBytes)` and `decryptProduct(bytes, key, capBytes)`, where the cap is a parameter from config and `FIRST_RELEASE_MAX_*` stays as the real-demo default; `serveCiphertext(req, res, lookup, {maxBytes})` with `ETag: "<sha256>"`, `Cache-Control: public, max-age=31536000, immutable`, `Accept-Ranges: bytes`, and single-range `206` support; browser `downloadCiphertext(url, expectedDigest, onProgress)` → `Uint8Array` that rejects on a digest mismatch.
- [ ] RED `crypto-size.test.ts`: 8 MiB round trip OK; 8 MiB + 1 B rejects with `PayloadTooLarge`; cap 41 still rejects 42 (real-demo unchanged); tampered byte → `DecryptionFailed`.
- [ ] RED `gateway-range.test.ts`: GET returns 200 and the correct ETag; `Range: bytes=0-99` returns 206 with a 100-byte body and a matching `Content-Range`; multi-range returns 416; `If-None-Match` returns 304; path traversal still returns 400 (reuse `inspectCiphertextPath`).
- [ ] RED `logos-storage.test.ts` additions: an upload of 8 MiB through the fake runner is correlated by sessionId; the per-call temp file is removed in `finally`; the size and digest are validated on download.
- [ ] Implement. `storage.ts` must remove any hardcoded 73-byte check and use the injected cap.
- **Verify:** `npx vitest run tests/unit/crypto-size.test.ts tests/unit/gateway-range.test.ts tests/unit/logos-storage.test.ts tests/unit/gateway.test.ts`.
- **Deviation expected:** the `server.ts` route wiring for `serveCiphertext` options. Report it; 3.3 owns `server.ts`.

## 3.3 Multi-product catalogue and embed surface

- **Owns:** `src/seller/server.ts`, `src/seller/catalogue.ts`, `src/browser/app.ts`, `src/browser/embed.ts` (new, built to `dist/browser/embed.js`), `vite.config.ts`, `index.html`, `checkout.html` (new), `tests/unit/catalogue-multi.test.ts` (new), `tests/unit/embed.test.ts` (new), `tests/unit/csp-static.test.ts`, `tests/browser/embed.spec.ts` (new), `playwright.config.ts`. Timebox 4 h.
- **Consumes:** `ProductSummary`, `EmbedConfig`, `CheckoutResult`, `config.publicOrigin`, and the D3 answer.
- **Produces (routes):** `GET /api/products` → `ProductSummary[]` (published, `available` from the cached `replicaReady`); `GET /api/products/:version` → `ProductSummary` or 404; `GET /p/:version` → checkout page for that product; `GET /embed.js` → static and immutable, with the SRI hash printed at build into `dist/browser/embed.sri.txt`. `/api/product` stays for backward compatibility and returns the oldest product.
- **Embed contract (D3a):** a seller pastes `<script src="https://store.<domain>/embed.js" integrity="sha384-…" crossorigin="anonymous" async></script><ssf-buy product="v1"></ssf-buy>`. `embed.ts` defines a `ssf-buy` custom element with a shadow-DOM button. On click it calls `window.open(origin + '/p/' + version + '?embed=1', 'ssf-checkout', 'popup,width=480,height=760')`, falling back to a new tab. The checkout page posts `CheckoutResult` to `window.opener` with `targetOrigin` = the opener origin, only when it is in `allowedEmbedOrigins` (or `*`). It never sends ids of other purchases. `embed.ts` validates `event.origin === storefrontOrigin` and runs `validateCheckoutResult`.
- **CSP:** app pages keep `frame-ancestors 'none'`. `/embed.js` is served with `Cross-Origin-Resource-Policy: cross-origin` and `Access-Control-Allow-Origin: *` (a public static script only). `connect-src` gains nothing new. `public-testnet` uses `buildCsp` with Waku peer origins, like real-demo.
- [ ] RED `catalogue-multi.test.ts`: publish v1 and v2 → `/api/products` lists both in creation order; unpublished products are hidden; `/api/products/nope` returns 404; `/p/v2` returns 200 HTML.
- [ ] RED `embed.test.ts` (jsdom-free: test pure functions `buildCheckoutUrl`, `acceptMessage(event, origin)`): a wrong origin is dropped; a malformed result is dropped; a valid result fires an `ssf:checkout` CustomEvent on the element.
- [ ] RED `tests/browser/embed.spec.ts`: a fixture seller on :8787 plus a static embedder page on :5001 (served from a temp dir by a Playwright `webServer`). Click the `ssf-buy` button, the popup opens `/p/<v>`, press **Buy** in the popup, the invoice shows, the embedder receives `state: 'invoiced'` via postMessage. Use real DOM controls, not `window.__ssf`.
- [ ] Implement. `app.ts` routes by `location.pathname` (`/` = catalogue list; `/p/:v` = product checkout; the existing purchases view is unchanged). The testnet badge text is taken from `profileFor(network)`, and the payment panel shows "testnet: delivered after 3 confirmations" from `config.minConfirmations`.
- **Verify:** focused vitest files above; the orchestrator runs `npm run build && npm run test:browser` at the wave gate.

## 3.4 Messaging hardening and abuse caps

- **Owns:** `src/adapters/waku.ts`, `src/browser/waku-transport.ts`, `src/seller/messages.ts`, `src/seller/orders.ts`, `src/seller/issuance.ts`, `scripts/live-infra/waku-peers.ts`, `tests/unit/waku-network-config.test.ts` (new), `tests/unit/order-rate-limit.test.ts` (new), `tests/unit/seller-messages.test.ts`. Timebox 3 h.
- **Consumes:** the D1 answer plus the 1.3 verdict (network config, peers).
- **Produces:** `WakuNetworkSettings = { networkConfig: typeof DefaultNetworkConfig | { clusterId: number; shards: number[] }, bootstrapPeers: string[] }` built from `config.live.waku.network` (parsed by 2.1; absent means `DefaultNetworkConfig`) and used identically by seller and browser (served via `/api/waku-config`; adding the field to that response is a deviation to 3.3). `IssuanceLimiter` in `orders.ts` reads `config.limits.openInvoicesPerBuyer` (default 3) and `config.limits.invoicesPerMinute` (default 30), both parsed by 2.1.
- **Why caps:** every invoice reserves a scanner receiver that is never reissued. A public Waku topic lets anyone spam `create` and burn receivers and DB rows.
- [ ] RED `order-rate-limit.test.ts`: a 4th open invoice for one buyer key is refused with `rate_limited`; a retry of the same `requestId` still replays the existing invoice (replay is not new issuance); the global per-minute cap refuses the 31st; after expiry the per-buyer slot frees.
- [ ] RED `waku-network-config.test.ts`: the seller and the browser build the same routing info for the same settings; unknown cluster ids are rejected.
- [ ] RED `seller-messages.test.ts` addition: the `rate_limited` response is signed and the browser renders "Too many open checkouts" (string asserted in `waku-transport` result mapping).
- [ ] Implement. Keep the HTTP/Waku dispatcher parity rule: `server.ts` fixture `/api/orders` must also consult the limiter (report as a deviation to 3.3).
- **Verify:** focused vitest files.

## 3.5 Deploy kit (Docker Compose for the Pi) and public doctor

- **Owns:** `deploy/**` (new: `deploy/compose.yaml`, `deploy/compose.replica.yaml`, `deploy/images/seller.Dockerfile`, `deploy/images/scanner.Dockerfile`, `deploy/images/logos.Dockerfile`, `deploy/cloudflared/config.yml.tmpl`, `deploy/env/public-testnet.env.example`, `deploy/build-images.sh`, `deploy/ship.sh`, `deploy/README.md`), `scripts/public-doctor.ts` (new), `scripts/start-public.ts` (new), `tests/unit/public-doctor.test.ts` (new), `tests/unit/deploy-templates.test.ts` (new). Timebox 3.5 h.
- **Consumes:** 1.2 Dockerfile for Logos, 1.3 delivery-node config.
- **Compose services** (all `platform: linux/arm64`, `restart: unless-stopped`, non-root user, `read_only: true` with named volumes for state, no published host ports except where noted):
  - Two compose files: `deploy/compose.yaml` (Pi) and `deploy/compose.replica.yaml` (`ssf-replica`).
  - Pi `logos-a`: the 1.2 image, volume `logos-a-data`; 8091/tcp published on the Pi's Tailscale IP only (`${PI_TAILNET_IP}:8091:8091`), never on 0.0.0.0. Buyers fetch ciphertext through the seller gateway, so no public storage port.
  - Replica `logos-b` + `replica-agent` (3.6) on `ssf-replica`: agent listens on `${REPLICA_TAILNET_IP}:8790` only.
  - `delivery`: the 1.3 delivery node; WS on `delivery:8000` inside the network.
  - `scanner`: release binary; volume `scanner-state`; socket in a shared volume mounted at `/run/ssf` (path ≤100 bytes); egress to `testnet.zec.rocks:443` only.
  - `seller`: `dist/` + production `node_modules`; `depends_on` scanner, logos-a (healthchecks); reaches B only through `SSF_REPLICA_AGENT_URL`; public port 8787 on the Compose network; admin port 8788 published ONLY to `127.0.0.1:8788` on the Pi host.
  - `cloudflared`: `cloudflare/cloudflared` (multi-arch) with `config.yml` routing `store.agentmascot.app` → `http://seller:8787` and `wss.agentmascot.app` → `http://delivery:8000`; credentials JSON mounted read-only from `deploy/secrets/` (0600, gitignored by 0.2); no ingress rule for 8788; final rule `http_status:404`.
- **Images:** `deploy/build-images.sh` runs `docker buildx build --platform linux/arm64 --load` on the aarch64 laptop for the Pi images (the scanner uses a Rust builder stage with `cargo build --locked --release`). The replica images (`logos` amd64, `replica-agent`) are built ON `ssf-replica` from the rsynced `deploy/` tree, so nothing is emulated. `deploy/ship.sh <pi|replica>` loads or builds images on the target over `tailscale ssh` and `rsync`s the right compose file and env example. It never copies `deploy/secrets/`.
- **public-doctor rows:** `tls` (valid cert on store. and wss.), `seller-public`, `admin-not-public` (`https://store.agentmascot.app:8788` and `/admin/health` via the tunnel both fail), `html-integrity` (served `index.html` sha256 equals the build's, catching Cloudflare injection), `scanner` (tip within 3 blocks of lightwalletd), `logos-a`, `logos-b-replica` (via the replica agent: B holds the latest published CID with the right digest), `delivery-wss` (a signed round trip via `wss.agentmascot.app`), `embed-js` (200, SRI matches `embed.sri.txt`), `backup-age` (< 24 h). PASS/FAIL/SKIP; `--strict` turns SKIP into FAIL; non-zero exit on FAIL.
- [ ] RED `deploy-templates.test.ts`: every `${VAR}` in compose/cloudflared templates is in `public-testnet.env.example`; every env key the example lists is read by `loadConfig` in public-testnet mode; no cloudflared ingress mentions 8788 or `admin`; the seller admin port binds only `127.0.0.1`; every Pi service sets `platform: linux/arm64` and every replica service `linux/amd64`, all with a non-root `user`; `8091` and `8790` bind only to the `*_TAILNET_IP` variables, never `0.0.0.0`; no service mounts `deploy/secrets` except cloudflared (read-only).
- [ ] RED `public-doctor.test.ts` with injected probe fakes: all pass → exit 0; one SKIP under `--strict` → exit 1; `html-integrity` fails on a single injected `<script>`; output never contains a token, UFVK, `utest1…`, URI, or tunnel credential (reuse the sanitizer in `scripts/live-report.ts`).
- [ ] Implement. `start-public.ts` is the seller container entrypoint: it reads `SSF_ENV_FILE` (default `/etc/ssf/public-testnet.env`) and execs `dist/service/main.js`, never printing env values.
- **Verify:** focused vitest files; `docker compose -f deploy/compose.yaml config -q` and `-f deploy/compose.replica.yaml config -q` exit 0; `bash -n deploy/*.sh`.
- **Deviation expected:** 3.6 owns the `replica-agent` Dockerfile content; 3.5 only references `deploy/images/replica-agent.Dockerfile` from the replica compose file.

## 3.6 Remote replica agent (replica B on another host)

- **Owns:** `src/replica-agent/main.ts` (new), `src/replica-agent/handlers.ts` (new), `src/adapters/remote-replica.ts` (new), `deploy/images/replica-agent.Dockerfile` (new), `tests/unit/replica-agent.test.ts` (new), `tests/unit/remote-replica.test.ts` (new). Timebox 3 h.
- **Why:** `liveStorage` (`src/adapters/live.ts:122-150`) calls `runner.call(config.logos.replicaConfigDir, 'peerId')` and verifies the replica through a local `logosctl --config-dir`. That only works when B is on the same machine. With B on `ssf-replica`, the seller needs a narrow network API to B.
- **Agent API** (on `ssf-replica`, bound to its Tailscale IP only, bearer token from a 0600 file shared with the seller):
  - `GET /v1/peer` → `{ peerId }`
  - `POST /v1/replicate` `{ cid, originMultiaddr, digest, sizeBytes }` → starts B's download from A by multiaddr (with the bounded "Failed to start download." retry from `logos-up.ts`) and returns `{ state: 'done' | 'pending' | 'failed' }`
  - `GET /v1/has/:cid?digest=&size=` → `{ present: boolean }`, true only after reading B's copy and matching size and sha256
  - `GET /v1/ciphertext/:cid` → the bytes (used by the seller gateway only when A is down)
  - Anything else → 404. CIDs are validated with the same regex the storage adapter uses. The agent never logs CIDs with digests, or tokens.
- **Seller side:** `createRemoteReplica({ url, tokenFile, timeoutMs })` implements the replica half of `LiveStorage` (`verifyReplica`, the fallback fetch, and `peerId` for `assertIndependentReplicas`). `liveStorage` uses it when `SSF_REPLICA_AGENT_URL` is set and the local `LOGOS_NODE_B` path otherwise, so local L keeps working unchanged. The config keys `SSF_REPLICA_AGENT_URL` (http:// is allowed only for a `100.64.0.0/10` Tailscale address or loopback) and `SSF_REPLICA_TOKEN_FILE` (0600) are parsed in `src/config.ts`. That file belongs to 2.1, so this is a deviation for the orchestrator; the wiring in `src/adapters/live.ts` is also a deviation.
- [ ] RED `replica-agent.test.ts` (handlers with a fake `LogosRunner`): 401 without the token; `has` false on a digest mismatch; `replicate` is idempotent for the same CID; unknown path → 404; a bad CID → 400.
- [ ] RED `remote-replica.test.ts` (against the handlers served on an ephemeral port): `verifyReplica` true only when `present`; the timeout maps to false (not ready), not a throw; equal peer ids throw `logos origin and replica are not independent peers`; a non-tailnet `http://` URL is rejected; responses over the size cap are rejected.
- [ ] Implement. `publishProduct` flow: upload on A, then `POST /v1/replicate`, then `has` until true or timeout; publication stays refused (503 "replica unavailable") until B confirms. This is the existing rule, now satisfied remotely.
- **Verify:** focused vitest files; the orchestrator applies both deviations and runs `tests/unit/live-composition.test.ts` plus the full suite at the W3 gate.

---

## W3 gate (orchestrator)

1. Apply every `deviation` (3.2→server.ts route options, 3.4→`/api/waku-config` field and fixture limiter, 3.6→config keys in `config.ts` and remote-replica wiring in `live.ts`). Ledger each one.
2. `npx vitest run > .runtime/diag/P3-vitest.log`; `npm run typecheck`; `npm run build`; `npm run test:browser`; the cargo trio; `git diff --check`. All green; flaky `build-provenance` re-run alone.
3. One read-only reviewer per subtask (6 in parallel), each with a package built from the working tree over that subtask's Owns (see the `sovereign-storefront-tdd` skill for package recipe). Critical/Important → one fixer → scoped re-review. Stop and ask after 3 rounds.
4. Regression: the local L live suites (`live-runtime`, `waku-flow.spec`) with `.runtime/live/live.env` sourced, so that regtest is not broken by the testnet work.
