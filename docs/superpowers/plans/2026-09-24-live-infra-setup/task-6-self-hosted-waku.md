# Task 6 (optional, decision-gated): self-hosted Waku node

**Do not start this without an explicit user decision.** Triggers: the user wants the L demo to not depend on the public Waku fleet, or Task 4.2 came back blocked. If it runs, it gets one fresh session and one spike worker (no further subtasks until the go/no-go).

## Findings that make this non-trivial on this host (aarch64 Linux)

- `wakuorg/nwaku` Docker images (`latest`, `v0.36.0`) are amd64-only. On this host they fail with `exec /usr/bin/wakunode: exec format error`, and binfmt/QEMU is not registered.
- `logos-delivery` GitHub releases ship `nwaku` for amd64-linux and arm64-macos only.
- `delivery_module` via logosctl defaults to preset `logos.test`, which is cluster **2**. The app uses cluster **1** (`src/adapters/waku.ts:90`, `DefaultNetworkConfig`). The browser WebSocket listener config is undocumented.

## Spike (timebox 2 h; the deliverable is a go/no-go report, not an implementation)

- Option 6a: build `logosdeliverynode` natively from `github.com/logos-messaging/logos-delivery` (`make logosdeliverynode`; Nim 2.2.6 via `make`, plus Rust). Run it with relay, filter and lightpush enabled, `--cluster-id=1`, a loopback wss listener with a local self-signed cert, and `--staticnode` pointing at itself only. Prove it with `tests/integration/waku.test.ts` and `WAKU_BOOTSTRAP_PEERS=/dns4/localhost/tcp/<port>/wss/p2p/<id>`.
- Option 6b: `docker run --privileged --rm tonistiigi/binfmt --install amd64`. **This needs root and changes host state, so ask the user first.** Then run `wakuorg/nwaku:v0.36.0` under emulation with the same flags.
- Either option requires Task 10 to accept a configured cluster and shard (`src/adapters/waku.ts:90`). That is a Task 10 code change, not infrastructure.

Report: which option was tried, build and run evidence (status words), the strict test result, and a go/no-go recommendation.
