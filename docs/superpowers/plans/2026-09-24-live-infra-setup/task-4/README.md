# Task 4 orchestrator: Waku — pin real public-network peers and prove strict mode

You are the Task 4 orchestrator, running in a fresh top-level session. Follow the protocol in `../README.md`. Spawn one fresh subagent per subtask, in order, verify each yourself, and update the ledger.

## Objective

`.runtime/live/waku/peers.json` (0600) is `{ discoveredAt, clusterId: 1, peers: string[] }` with at least 2 browser-dialable `wss` multiaddrs. `live.env` holds `WAKU_BOOTSTRAP_PEERS` (comma-joined) and `SSF_WAKU_CONTENT_TOPIC=/sovereign-storefront/1/live/proto`. The strict Waku integration test passes on the pinned peers alone, 3 times. The doctor shows `waku PASS`.

## State at split time

- `scripts/live-infra/waku-peers.ts` (95 lines) exists: `browserDialable()` is unit-tested and green (`tests/unit/live-infra-waku.test.ts`). `main()` has **never run**. The SDK shapes it uses (`libp2p.getConnections()`, `peerStore.get(peerId).protocols`/`.addresses`) are best-effort guesses, not checked against the installed `@waku/sdk` 0.0.36.
- `tests/integration/waku.test.ts` passed 3 times earlier against the public fleet with `defaultBootstrap` (cluster 1). When `WAKU_BOOTSTRAP_PEERS` is set, `src/adapters/waku.ts` disables `defaultBootstrap`.
- `src/adapters/waku.ts:90` hardcodes `DefaultNetworkConfig` (cluster 1).

## Subtasks (sequential)

| # | File | Timebox | Done means |
| --- | --- | --- | --- |
| 4.1 | `4.1-waku-sdk-api-verification.md` | 45 min | Every SDK call in `waku-peers.ts` is checked against the installed types; a pure extraction helper is unit-tested |
| 4.2 | `4.2-waku-live-pinning-and-strict-proof.md` | 60 min | `peers.json` written; strict test 3/3 on pinned peers; doctor `waku PASS` |

Dispatch as described in `../task-2/README.md`.

## Verify after each subtask

- 4.1: `npx vitest run tests/unit/live-infra-waku.test.ts` passes and `npm run typecheck` is clean.
- 4.2: `SSF_STRICT_LIVE=1 npm run infra:doctor 2>&1 | grep '^waku'` shows PASS. The ledger records 3 strict-run durations.

## Risk and fallback

The public fleet is outside our control. If 4.2 is flaky, re-pin once. If it still fails, the doctor reports `waku FAIL` in strict mode. **Stop and ask the user about Task 6 (self-hosted).** Never substitute a fixture or an in-memory transport.

## Task 4 Done

Both subtasks are done, and `waku PASS` in strict mode. Mark Task 4 done in `../README.md`.
