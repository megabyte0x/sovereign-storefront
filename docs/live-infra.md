# Live infrastructure (local target L)

## Purpose

Local target L is the live stack this app is tested against on one machine: a real Zcash regtest chain (`ths` environment `ssf-live`) with an independently scanning wallet scanner, two local Logos `storage_module` nodes, and pinned public Waku peers (cluster 1). Mainnet is never used. Public-testnet target T is separate and not covered here.

What it provides:

- **Task 10** (built live runtime, `start:live`): reads `.runtime/live/live.env` to get the scanner socket and account, the Logos CLI and node config dirs, and the Waku bootstrap peers and content topic. It does not start or discover infrastructure itself.
- **Task 12** (strict built-app acceptance): brings the stack up with `npm run infra:up`, gates on the strict doctor (all six rows PASS), and runs the live browser suite against the same resources.

## Commands

| Command | What it does |
| --- | --- |
| `npm run infra:up` | Runs `zcash-up.ts`, `logos-up.ts` and `waku-peers.ts` in that order, stopping at the first failure. Each stage's output goes to `.runtime/live/diag/up-<stage>-<timestamp>.log` (0600). Only each stage's final status line is printed, then the strict doctor rows. Idempotent: about 20 s when everything is already up. |
| `npm run infra:doctor` | Probes six rows: `zcash`, `scanner`, `logos-a`, `logos-b`, `logos-replication`, `waku`. An unreachable dependency is `SKIP` with a reason. Writes `.runtime/live/status.json`. |
| `SSF_STRICT_LIVE=1 npm run infra:doctor` | Same probes, but an unreachable dependency is `FAIL` with a reason, and the exit code is nonzero. There is never a synthetic PASS. |
| `npm run infra:down` | Runs `logos-down.ts`, then `zcash-down.ts` (output streamed), then checks for owned leftovers: the `tsz-ssf-live` docker containers, Logos node processes, the `ths start --name ssf-live` process, and a live scanner `serve.pid`. It prints `leftover <kind>: N still present` for each one found and exits 1. On a clean run it prints `infra=down leftovers=none`. A failing stage prints `<stage>-down exit=N` and the leftover checks still run. |

Per-stack scripts (run with `node --experimental-strip-types scripts/live-infra/<script>`):

| Script | Flags and env | Notes |
| --- | --- | --- |
| `zcash-up.ts` | `ZCASH_UP_TRACE=1` prints timestamped step labels to stderr. `THS_ENV_NAME` must be `ssf-live` if set. | Starts `ths start --name ssf-live` (output to `zcash/ths-start.log`, 0600), waits for endpoints and wallet sync, provisions the scanner runtime again if needed, builds the scanner, runs `init-view`, starts `serve`, mines a block and waits for the scanner generation to advance. If a `serve` for this config is already running, it skips `init-view` and restart. Prints `zcash=up scanner=ready generation_advanced=true`. |
| `zcash-down.ts` | `--reset` also runs `ths reset --name ssf-live --force` and deletes `SCANNER_DIR`. | Stops the scanner `serve` (by PID file, after a cmdline check), runs `ths stop`, kills the owned `ths start` process by `zcash/ths.pid`, and fails if `tsz-ssf-live` containers remain. Prints `zcash=down`. |
| `logos-up.ts` | none | Downloads and verifies the `logosctl` AppImage, starts nodes A and B, connects B to A, and runs a replication proof (upload on A, fetch on B, digest compare). Prints `logos-a=up logos-b=up replication=digest_match`. |
| `logos-down.ts` | `--purge` also deletes each node's `storage-data/`. | For each running node: `storage_module stop`, then `destroy`, then `daemon stop`. Config dirs are kept. Prints `logos=down`. |
| `waku-peers.ts` | `--dry-run` connects and counts dialable peers, and writes nothing. | Finds at least 2 browser-dialable (wss) cluster-1 peers that support both light push and filter. Pins them in `waku/peers.json`. Prints `waku_peers=N cluster=1`. |
| `up.ts`, `down.ts`, `doctor.ts` | `SSF_STRICT_LIVE=1` (doctor) | Back the `infra:*` npm scripts. |

`paths.ts` also accepts `SSF_LIVE_SCANNER_DIR` (an absolute path) to override the scanner directory.

## Runtime layout

Directories are mode 0700. Config, log, env, key and PID files are 0600.

    .runtime/live/                          (worktree, gitignored)
      live.env                              non-secret pointers for Task 10
      status.json                           last doctor result
      diag/up-<stage>-<ts>.log              infra:up stage logs
      zcash/ths-start.log                   ths launcher output: SECRET (mnemonic, spending keys)
      zcash/ths.pid                         owned `ths start` process
      zcash/endpoints.json                  endpoints from `ths endpoints` for the current start
      logos/bin/logosctl-aarch64.AppImage
      logos/node-a/, logos/node-b/          logosctl config dirs (storage-init.json, storage-data/, daemon/state.json)
      logos/replication.json                replication proof checked by the doctor
      logos/status.json                     AppImage digest and node peer ids
      waku/peers.json                       pinned wss multiaddrs

    SCANNER_DIR = $XDG_STATE_HOME/ssf-live/scanner   (default ~/.local/state/ssf-live/scanner)
      scanner.json                          UFVK + birthday + runtime section: SECRET
      .scanner.json.live-state/             wallet.sqlite, scanner.sqlite, scanner.sock
      serve.pid, serve.log

**Why `SCANNER_DIR` is outside the worktree:** the scanner's Unix socket path is derived from its config dir, and Linux caps `sockaddr_un.sun_path` at 108 bytes. Under the deep worktree `.runtime/` path the socket path was too long. The Rust scanner still binds (it binds through a short `/proc/self/fd/N/...` path), but every client connecting by absolute path gets `ENOENT`. `paths.ts` `assertSocketPathFits` rejects socket paths that are relative or longer than 100 bytes.

## `live.env` keys

Values are paths or public identifiers only. To inspect it, list the keys with `cut -d= -f1 .runtime/live/live.env` and never print the values.

| Key | Written by | Meaning |
| --- | --- | --- |
| `SSF_SCANNER_SOCKET` | zcash-up | Absolute path of the scanner's Unix socket under `SCANNER_DIR`. |
| `SSF_SCANNER_ACCOUNT_ID` | zcash-up | Scanner account id, read from the scanner snapshot. |
| `SSF_SCANNER_SOURCE_ID` | zcash-up | Scanner source id (the `ths` env name). |
| `THS_ENV_NAME` | zcash-up | Owned `ths` environment name (`ssf-live`). |
| `LOGOSCTL` | logos-up | Absolute path of the `logosctl` AppImage. |
| `LOGOS_NODE_A` | logos-up | Config dir of Logos node A (origin). |
| `LOGOS_NODE_B` | logos-up | Config dir of Logos node B (replica). |
| `APPIMAGE_EXTRACT_AND_RUN` | logos-up | `1`, so the AppImage runs without FUSE. |
| `WAKU_BOOTSTRAP_PEERS` | waku-peers | Comma-separated pinned wss multiaddrs (cluster 1). |
| `SSF_WAKU_CONTENT_TOPIC` | waku-peers | Content topic for the live app's Waku traffic. |

## What the Logos docs require, and what this app actually needs

(Copied from `docs/superpowers/plans/2026-09-24-live-infra-setup.md`.)

docs.logos.co "Run a node" describes a public testnet **operator** node: root, a `logos` system user, systemd, a public IPv4, open ports 3000/8090/8091/9000/30303, and `blockchain_module` 0.2.4 + `storage_module` 2.1.2 + `delivery_module` 0.2.1. **Most of that does not apply here:**

- `blockchain_module` (Logos Cryptarchia chain) is not used. Payments are Zcash. Its x86 ADX CPU requirement is irrelevant on aarch64 and is not needed.
- `delivery_module` is not used by the app. The seller and the browser use `@waku/sdk` light nodes directly (Gate A decision). A `delivery_module` node on the `logos.test` preset is cluster 2, but `src/adapters/waku.ts:90` hardcodes `DefaultNetworkConfig` (cluster 1), so a delivery_module node would not even see the app's traffic without a code change.
- Only `storage_module` is required, run as **two unprivileged sessions** following the storage-node page (the path the Task 8 adapter already targets through `--config-dir`). No root, systemd, public IP or firewall changes are needed. The two nodes connect directly over loopback.

Fixed local Logos ports (configuration in `logos-up.ts`): node A listens on 18091/tcp with discovery on 18090/udp. Node B listens on 18191/tcp with discovery on 18190/udp. `ths` picks random ports on each start. Always discover them with `ths endpoints --name ssf-live --json` and never hardcode them.

## Secret handling

- `zcash/ths-start.log` holds the disposable mnemonic and spending keys (`ths start` prints them on first start). It is 0600. Never print, cat, paste or commit it.
- The UFVK exists only in 0600 files (`SCANNER_DIR/scanner.json`, generated by the provisioning helper). It is never passed on a command line or printed.
- Doctor and script evidence is limited to prefixes, heights, generations, counts and PASS/FAIL/SKIP reasons. Do not report endpoint values, runtime-discovered ports, keys, addresses, txids or CIDs.
- Never paste logs (`ths-start.log`, `serve.log`, `diag/*.log`) into chat, issues or commits. Quote a path and a short summary instead.

## Ownership

Owned resources, the only ones these scripts may start, stop or delete:

- `ths` environment `ssf-live` (docker containers `tsz-ssf-live*`) and its `ths start` process (`zcash/ths.pid`).
- The scanner `serve` process, identified by `SCANNER_DIR/serve.pid` after a `/proc/<pid>/cmdline` check.
- The Logos config dirs `.runtime/live/logos/node-a` and `.runtime/live/logos/node-b` and their daemons.

Never touched: the `ths` environments `ssf-task1`, `ssf-task3-live`, `default` and `p-happy`, and any other container or process that is not owned. `zcash-up`/`zcash-down` refuse any `THS_ENV_NAME` other than `ssf-live`.

## Troubleshooting

- **Scanner socket `ENOENT` or an apparently slow scanner start:** check `Buffer.byteLength(socketPath)` first. A socket path longer than the `sun_path` limit binds but cannot be connected to. Keep scanner state in `SCANNER_DIR`.
- **`ths start` process lingers after `ths stop`:** `ths stop` tears down the environment but not the foreground `ths start` process. `zcash-down` kills it through `zcash/ths.pid`, and `infra:down` reports it as a `ths-start-process` leftover.
- **Scanner config stale after restart:** `ths` assigns random ports on each start, so `zcash-up` compares `scanner.json` against the live endpoints and provisions it again when they differ.
- **Logos B never finds A:** DHT discovery fails for two loopback-only nodes. `logos-up` connects B to A with an explicit loopback multiaddr (`/ip4/127.0.0.1/tcp/<A listen port>/p2p/<A peer id>`).
- **Scanner cold start:** the measured scanner-only cold start (starting → ready) is about 2 s. The older 300–500 s figure was the socket-path `ENOENT` artifact, so the ready deadline is 180 s. A much longer wait points to a real fault, not slowness.
