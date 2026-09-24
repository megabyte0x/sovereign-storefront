# Live Test Infrastructure Setup Plan (local target L)

> **Execution moved (2026-09-24):** do not execute from this file. Tasks are split into per-session orchestrator/subtask files under `2026-09-24-live-infra-setup/` (start with its `README.md`). This file remains the design record.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring up every external dependency that Task 10 (live runtime assembly) and Task 12 (strict L demo) need on this machine. Prove each one with the repository's own live checks, then write one private environment file that Task 10 consumes.

**Architecture:** Three independent dependency stacks, all owned by this checkout and torn down by name. (1) Zcash: a `ths` regtest environment (Zakura node + lightwalletd in Docker) with the repository's viewing-only scanner running `serve` against it. (2) Logos Storage: two `logosctl` 0.2.3 sessions (origin A, replica B), each running `storage_module` 2.1.2 with its own data directory. (3) Waku: the public Waku network reached through `@waku/sdk` bootstrap, with the discovered secure-WebSocket peers pinned for CSP and strict-mode checks. A small doctor script reports PASS, FAIL or SKIP for each row. `up`/`down` scripts start and stop only the resources they own.

**Tech stack:** `ths` 0.2.1 (installed at `~/.cargo/bin/ths`), Docker 29.7.2, cached images `zakuracore/zakura:1.4.0` and `ghcr.io/zcashlabs/thus-spoke-zakura-{app,lightwalletd}:0.2.1`; Rust scanner `services/scanner` and helper `tools/payment-test-wallet`; `logosctl` 0.2.3 aarch64 AppImage; `@waku/sdk` 0.0.36; Node 22.23.2; `/usr/bin/chromium`.

**Spec:** `docs/superpowers/specs/2026-09-23-live-mvp-integration-design.md` (sections 2 "L", 3, 7, 8), and `docs/superpowers/plans/2026-09-23-live-mvp-integration.md` Tasks 8, 10 and 12. Logos operator docs: https://docs.logos.co/run-a-node and https://docs.logos.co/storage/get-started/run-logos-storage-node.

## Why the previous "no live infrastructure" stop is incorrect

Evidence gathered 2026-09-24 on this host (aarch64, Apple M2 Pro under Asahi Linux, 10 cores, 31 GiB RAM, 51 GiB free):

| Dependency | Previous claim | Actual state |
| --- | --- | --- |
| Scanner and chain | "no live scanner" | `ths doctor --json` reports `ok:true`. The images are cached. Task 3 already ran owned `ssf-task3-live`/`ssf-task3-reorg` stacks through provisioner → `init-view` → `serve` → TypeScript adapter, including a funded receipt and a restart (see `docs/scanner-projection-compatibility.md`). It only has to be started again. |
| Waku bootstrap peers | "no real Waku bootstrap peers" | `tests/integration/waku.test.ts` passed three times against the public js-waku fleet (`defaultBootstrap`, cluster 1), in 13.4 s, 13.0 s and 8.9 s (plan Task 6 status). What is missing is a pinned peer list, not peers. |
| Logos nodes | "no Logos nodes" | The storage spike ran two nodes on this machine. A verified `logosctl-aarch64-linux.tar.gz` (SHA-256 `f1ed1deb…b3c3`, matching `spikes/storage/README.md`) and an extracted AppImage are already in `.worktrees/feat-mvp-t2/spikes/storage/runtime/`. Nothing is running now. |
| Browser | — | `/usr/bin/chromium` and Playwright chromium builds 1187/1234/1243 are present. |

## What the Logos docs require, and what this app actually needs

docs.logos.co "Run a node" describes a public testnet **operator** node: root, a `logos` system user, systemd, a public IPv4, open ports 3000/8090/8091/9000/30303, and `blockchain_module` 0.2.4 + `storage_module` 2.1.2 + `delivery_module` 0.2.1. **Most of that does not apply here:**

- `blockchain_module` (Logos Cryptarchia chain) is not used. Payments are Zcash. Its x86 ADX CPU requirement is irrelevant on aarch64 and is not needed.
- `delivery_module` is not used by the app. The seller and the browser use `@waku/sdk` light nodes directly (Gate A decision). A `delivery_module` node on the `logos.test` preset is cluster 2, but `src/adapters/waku.ts:90` hardcodes `DefaultNetworkConfig` (cluster 1), so a delivery_module node would not even see the app's traffic without a code change.
- Only `storage_module` is required, run as **two unprivileged sessions** following the storage-node page (the path the Task 8 adapter already targets through `--config-dir`). No root, systemd, public IP or firewall changes are needed. The two nodes connect directly over loopback.

## Global constraints

- This plan authorizes infrastructure setup and live **checks** only. It is not authorization to implement Task 10, commit, push, modify `ths` or upstream repositories, or use mainnet.
- All runtime state goes under `.worktrees/live-mvp-integration/.runtime/live/` (already covered by `.gitignore` `.runtime/`). Directories are mode `0700`; config, log, env and key files are `0600`.
- `ths start` prints the disposable mnemonic and spending keys to stdout on first start. Redirect all launcher output to a `0600` file and **never** print, paste or commit it. The scanner receives only a helper-generated UFVK file path; never pass UFVK or keys on a command line.
- Own resources by name: the `ths` environment `ssf-live`, the Logos config dirs `.runtime/live/logos/node-{a,b}`, and the scanner PID file. Teardown must never stop `ssf-task1`, `default`, `p-happy` or any non-owned container or process.
- Fixed local ports (all checked free on 2026-09-24): Logos A listen 18091/tcp, disc 18090/udp; Logos B listen 18191/tcp, disc 18190/udp. `ths` chooses its own ports; always discover them with `ths endpoints --name ssf-live --json`.
- A dependency that cannot be reached is a FAIL with a reason under strict mode (`SSF_STRICT_LIVE=1`) and a SKIP with a reason otherwise. It is never a synthetic PASS. Deterministic tests are never reported as live evidence.
- Append every concrete `ths` usability observation to `~/.hermes/skills/software-development/zakura-regtest/references/ths-dx-backlog.md` during execution.
- Known accepted limitation (not infrastructure): the scanner's bounded reorg-detection window from Task 3 remains. Do not run reorg experiments in this plan.

## Runtime layout (produced by Tasks 1–4)

    .runtime/live/                     0700
      live.env                         0600  non-secret pointers consumed by Task 10
      status.json                      0600  last doctor result
      zcash/ths-start.log              0600  launcher output (contains secrets, never read back into chat)
      zcash/endpoints.json             0600
      scanner/scanner.json             0600  UFVK + birthday + runtime section (secret)
      scanner/.scanner.json.live-state/  wallet.sqlite, scanner.sqlite, scanner.sock (scanner-created)
      scanner/serve.pid, serve.log     0600
      logos/bin/logosctl-aarch64.AppImage  0700
      logos/node-a/, logos/node-b/     0700  logosctl config dirs
      logos/node-{a,b}/storage-init.json 0600
      logos/node-{a,b}/storage-data/   0700
      waku/peers.json                  0600  pinned wss multiaddrs

`live.env` keys (names match plan Task 10, values are paths or public identifiers only):

    SSF_MODE=real-demo
    SSF_NETWORK=regtest
    SSF_SCANNER_SOCKET=<abs>/.runtime/live/scanner/.scanner.json.live-state/scanner.sock
    SSF_SCANNER_ACCOUNT_ID=<from GET /v1/snapshot>
    SSF_SCANNER_SOURCE_ID=ssf-live
    LOGOSCTL=<abs>/.runtime/live/logos/bin/logosctl-aarch64.AppImage
    LOGOS_NODE_A=<abs>/.runtime/live/logos/node-a
    LOGOS_NODE_B=<abs>/.runtime/live/logos/node-b
    APPIMAGE_EXTRACT_AND_RUN=1
    WAKU_BOOTSTRAP_PEERS=<comma-separated /dns4/…/wss/p2p/… from waku/peers.json>
    SSF_WAKU_CONTENT_TOPIC=/sovereign-storefront/1/live/proto
    THS_ENV_NAME=ssf-live

---

## Task 1: Runtime layout and live-infra doctor

**Files:**
- Create: `scripts/live-infra/doctor.ts`, `scripts/live-infra/paths.ts`, `tests/unit/live-infra-doctor.test.ts`
- Modify: `package.json` (add `"infra:doctor": "node --experimental-strip-types scripts/live-infra/doctor.ts"`)

**Interfaces:**
- Consumes: `.runtime/live/live.env` (may be absent), `node:http` Unix-socket requests, `ths`, `logosctl`.
- Produces:
  - `paths.ts`: `export const LIVE_ROOT: string` (absolute `.runtime/live`); `export function ensurePrivateDir(path: string): void` (creates with `0o700`, and throws if it exists with a different mode or is a symlink).
  - `doctor.ts`: `export type Row = { id: 'zcash' | 'scanner' | 'logos-a' | 'logos-b' | 'logos-replication' | 'waku'; status: 'PASS' | 'FAIL' | 'SKIP'; reason: string; evidence?: Record<string, string | number | boolean> }`; `export function parseEnvFile(text: string): Record<string, string>`; `export function classify(ok: boolean | undefined, reason: string, strict: boolean): Pick<Row, 'status' | 'reason'>`; `export function summarize(rows: Row[], strict: boolean): { ok: boolean; exitCode: 0 | 1 }`; and a CLI that writes `status.json` (0600) and prints one line per row with no secret values.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/live-infra-doctor.test.ts
import { describe, expect, it } from 'vitest';
import { classify, parseEnvFile, summarize } from '../../scripts/live-infra/doctor.ts';

describe('live-infra doctor', () => {
  it('parses KEY=value lines and ignores comments/blank lines', () => {
    expect(parseEnvFile('# c\nA=1\n\nB=/x=y\n')).toEqual({ A: '1', B: '/x=y' });
  });
  it('rejects malformed lines instead of guessing', () => {
    expect(() => parseEnvFile('NOVALUE\n')).toThrow('malformed env line 1');
  });
  it('unreachable dependency is SKIP when lenient and FAIL when strict, never PASS', () => {
    expect(classify(undefined, 'socket missing', false)).toEqual({ status: 'SKIP', reason: 'socket missing' });
    expect(classify(undefined, 'socket missing', true)).toEqual({ status: 'FAIL', reason: 'socket missing' });
    expect(classify(false, 'health=unavailable', false).status).toBe('FAIL');
    expect(classify(true, 'ok', true).status).toBe('PASS');
  });
  it('strict summary fails on any SKIP; lenient summary fails only on FAIL', () => {
    const rows = [
      { id: 'zcash', status: 'PASS', reason: 'ok' },
      { id: 'waku', status: 'SKIP', reason: 'no peers' },
    ] as const;
    expect(summarize([...rows], true)).toEqual({ ok: false, exitCode: 1 });
    expect(summarize([...rows], false)).toEqual({ ok: true, exitCode: 0 });
  });
});
```

- [ ] **Step 2: Run to confirm RED**

Run: `npx vitest run tests/unit/live-infra-doctor.test.ts`
Expected: FAIL, because the module `scripts/live-infra/doctor.ts` does not exist.

- [ ] **Step 3: Implement pure helpers and probes**

```ts
// scripts/live-infra/doctor.ts (pure part)
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(`malformed env line ${index + 1}`);
    out[line.slice(0, eq)] = line.slice(eq + 1);
  });
  return out;
}
export function classify(ok: boolean | undefined, reason: string, strict: boolean) {
  if (ok === true) return { status: 'PASS' as const, reason };
  if (ok === false) return { status: 'FAIL' as const, reason };
  return { status: strict ? 'FAIL' as const : 'SKIP' as const, reason };
}
export function summarize(rows: { status: string }[], strict: boolean) {
  const bad = rows.some((r) => r.status === 'FAIL' || (strict && r.status === 'SKIP'));
  return { ok: !bad, exitCode: bad ? 1 as const : 0 as const };
}
```

Probes in the same file (CLI section, `if (import.meta.url === \`file://${process.argv[1]}\`)`), each bounded by a 15 s deadline:
  - `zcash`: `ths status --name ${THS_ENV_NAME} --json` → `running === true`; then JSON-RPC `getblockchaininfo` on the discovered `rpc` endpoint → evidence `{ blocks }`.
  - `scanner`: `http.request({ socketPath: SSF_SCANNER_SOCKET, path: '/v1/snapshot' })` → PASS only if `complete === true && health === 'ready'` and `Date.now() - checkedAt <= 120_000`. Evidence: `generation`, `tip.height`, `accountId`. Receipts are never printed.
  - `logos-a` / `logos-b`: `${LOGOSCTL} --config-dir ${dir} --json call storage_module debug` → PASS if `result.value.id` is a non-empty string. Evidence: peer-id prefix (first 12 chars), matching the spike's redaction.
  - `logos-replication`: PASS only if `status.json` from Task 3 Step 6 records a current-run CID digest match. Otherwise SKIP with reason `not yet proven this run`.
  - `waku`: runs `npx vitest run --config vitest.integration.config.ts tests/integration/waku.test.ts` with `WAKU_BOOTSTRAP_PEERS` and `SSF_STRICT_LIVE_WAKU=1` from `live.env`; PASS on exit 0 and a non-skipped test (parse vitest's `--reporter=json` `numPassedTests === 1`).
  - Missing `live.env` or key → `classify(undefined, 'LIVE_ENV missing <KEY>', strict)`.

- [ ] **Step 4: Run to confirm GREEN, then run the doctor once**

Run: `npx vitest run tests/unit/live-infra-doctor.test.ts` → 4 passed.
Run: `npm run infra:doctor` → every row SKIP with reason (nothing is up yet); exit 0. Then `SSF_STRICT_LIVE=1 npm run infra:doctor` → exit 1.

- [ ] **Step 5: Regression gates**

Run: `npm test && npm run typecheck && git diff --check`. No commit unless separately authorized.

---

## Task 2: Zcash regtest environment and live scanner daemon

**Files:**
- Create: `scripts/live-infra/zcash-up.ts`, `scripts/live-infra/zcash-down.ts`, `tests/unit/live-infra-zcash.test.ts`
- Modify: `scripts/qualify-payments.ts` (export the existing `helperArguments` and `dashboardNetwork` only; no behavior change)

**Interfaces:**
- Consumes: `localRegtestParametersFromRpc(...)`, `helperArguments(configFile, parameters)` (made exported) from `scripts/qualify-payments.ts`; `scripts/provision-scanner-runtime.ts --config --rpc --dashboard --lightwalletd --source-id`; scanner CLI `init-view --config FILE`, `serve --config FILE`.
- Produces: running `ths` env `ssf-live`; running scanner `serve` whose PID is in `scanner/serve.pid`; the `live.env` keys `SSF_SCANNER_SOCKET`, `SSF_SCANNER_ACCOUNT_ID`, `SSF_SCANNER_SOURCE_ID`, `THS_ENV_NAME`; `zcash-down.ts` that stops only these.

- [ ] **Step 1: Failing test for the ownership guard and argument building**

```ts
// tests/unit/live-infra-zcash.test.ts
import { describe, expect, it } from 'vitest';
import { assertOwnedEnvName, serveCommand } from '../../scripts/live-infra/zcash-up.ts';

describe('zcash-up', () => {
  it('only operates on the owned ths environment', () => {
    expect(() => assertOwnedEnvName('ssf-live')).not.toThrow();
    for (const other of ['default', 'ssf-task1', 'p-happy', '']) {
      expect(() => assertOwnedEnvName(other)).toThrow('not an owned environment');
    }
  });
  it('builds serve with a config path and never a key argument', () => {
    const argv = serveCommand('/abs/.runtime/live/scanner/scanner.json');
    expect(argv).toEqual(['run', '--locked', '--release', '--quiet', '--manifest-path',
      'services/scanner/Cargo.toml', '--', 'serve', '--config', '/abs/.runtime/live/scanner/scanner.json']);
    expect(argv.join(' ')).not.toMatch(/uview|ufvk|seed/i);
  });
});
```

- [ ] **Step 2: Run to confirm RED**

Run: `npx vitest run tests/unit/live-infra-zcash.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement `zcash-up.ts`**

The sequence is idempotent: each step checks state first.
  1. `assertOwnedEnvName(process.env.THS_ENV_NAME ?? 'ssf-live')`, then `ensurePrivateDir` for `zcash/` and `scanner/`.
  2. If `ths status --name ssf-live --json` reports not running, spawn `ths start --name ssf-live --no-open` **detached**. Send stdout and stderr to `zcash/ths-start.log`, opened with `fs.openSync(path, 'a', 0o600)`. Record the launcher PID in `zcash/ths.pid`. `ths start` runs in the foreground, and interrupting it deletes the environment. Keep it running, and never send it SIGINT except from `zcash-down`.
  3. Poll `ths endpoints --name ssf-live --json` plus dashboard `GET /api/v1/status` until `wallet_sync.state === 'ready'`, with a 180 s monotonic deadline. Write `zcash/endpoints.json` (0600).
  4. If `scanner/scanner.json` is absent: read `getblockchaininfo` and derive parameters with `localRegtestParametersFromRpc`. Run `cargo run --locked --quiet --manifest-path tools/payment-test-wallet/Cargo.toml -- ...helperArguments(scannerJson, params)`, which writes `{ufvk, birthday}` 0600 and prints nothing secret. Then run `node --experimental-strip-types scripts/provision-scanner-runtime.ts --config <scannerJson> --rpc <rpc> --dashboard <dashboard> --lightwalletd <lwd> --source-id ssf-live`.
  5. `cargo build --locked --release --manifest-path services/scanner/Cargo.toml`, then `init-view --config <scannerJson>`. Expect the stdout line `scanner_view_initialized`. The step is idempotent per the Task 3 tests.
  6. Spawn `serve` (per `serveCommand`) detached, with logs to `scanner/serve.log` (0600) and the PID to `scanner/serve.pid`. Poll the socket `GET /v1/snapshot` until `complete && health === 'ready'` (deadline 300 s). If the PID exits first, fail immediately.
  7. Mine `ths mine --name ssf-live 1` once, then re-poll. The snapshot `generation` must increase and `tip.height` must advance by 1. This proves the lifecycle worker is live and not a stale publication.
  8. Merge `SSF_SCANNER_SOCKET`, `SSF_SCANNER_ACCOUNT_ID` (from the snapshot `accountId`), `SSF_SCANNER_SOURCE_ID=ssf-live` and `THS_ENV_NAME=ssf-live` into `live.env`. Rewrite atomically: write to a temp file, `fsync`, rename, mode 0600.

`zcash-down.ts`: SIGTERM the PID in `serve.pid` (only if `/proc/<pid>/cmdline` contains `sovereign-storefront-scanner` and `serve`), wait up to 10 s, then run `ths stop --name ssf-live`. With `--reset`, also run `ths reset --name ssf-live` and remove `scanner/` (this destroys the view wallet; ask before using it in a demo run). Finally verify `docker ps --filter name=tsz-ssf-live -q` is empty.

- [ ] **Step 4: GREEN and live bring-up**

Run: `npx vitest run tests/unit/live-infra-zcash.test.ts` → 2 passed.
Run: `node --experimental-strip-types scripts/live-infra/zcash-up.ts`
Expected: `zcash=up scanner=ready generation_advanced=true` (status words only).
Run: `npm run infra:doctor` → `zcash PASS`, `scanner PASS`.

- [ ] **Step 5: Existing live scanner check against this stack**

Run: `SSF_SCANNER_SOCKET=... npx vitest run tests/unit/wallet-scanner.test.ts`. This is deterministic, so it confirms that nothing regressed; it is not live evidence. The live evidence is Step 4's generation advance. Record `ths` observations in the DX backlog (for example: no detach flag, secrets on stdout, and `endpoints` without network/TLS fields, if they are still true).

---

## Task 3: Two local Logos Storage nodes (origin A, replica B)

**Files:**
- Create: `scripts/live-infra/logos-up.ts`, `scripts/live-infra/logos-down.ts`, `tests/unit/live-infra-logos.test.ts`

**Interfaces:**
- Consumes: logosctl release `0.2.3` asset `logosctl-aarch64-linux.tar.gz` (SHA-256 `f1ed1debcac20a9943ae2786021f574e439af42f853db0e753a365acb45eb3c3`), catalogue package `storage_module` `2.1.2` root hash `19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740`.
- Produces: two running logosctl daemons with `storage_module` started, and the `live.env` keys `LOGOSCTL`, `LOGOS_NODE_A`, `LOGOS_NODE_B`, `APPIMAGE_EXTRACT_AND_RUN=1`.

- [ ] **Step 1: Failing test for config generation**

```ts
// tests/unit/live-infra-logos.test.ts
import { describe, expect, it } from 'vitest';
import { storageInit, ARCHIVE_SHA256 } from '../../scripts/live-infra/logos-up.ts';

describe('logos-up', () => {
  it('writes absolute, node-separated storage configs on fixed ports', () => {
    const a = storageInit('/abs/logos/node-a', 18091, 18090);
    const b = storageInit('/abs/logos/node-b', 18191, 18190);
    expect(a).toEqual({ 'data-dir': '/abs/logos/node-a/storage-data', 'log-file': '/abs/logos/node-a/storage-data/storage.log',
      'log-level': 'INFO', 'listen-port': 18091, 'disc-port': 18090, network: 'logos.test' });
    expect(a['data-dir']).not.toBe(b['data-dir']);
    expect(() => storageInit('relative/dir', 1, 2)).toThrow('absolute');
  });
  it('pins the verified archive digest', () => {
    expect(ARCHIVE_SHA256).toBe('f1ed1debcac20a9943ae2786021f574e439af42f853db0e753a365acb45eb3c3');
  });
});
```

- [ ] **Step 2: Run to confirm RED**

Run: `npx vitest run tests/unit/live-infra-logos.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `logos-up.ts`** (idempotent; no sudo, and no `install-logosctl.sh`, because it writes `/usr/local/bin`)
  1. `ensurePrivateDir` for `logos/`, `logos/bin`, `logos/node-a` and `logos/node-b`.
  2. Obtain the archive: copy `.worktrees/feat-mvp-t2/spikes/storage/runtime/logosctl-aarch64-linux.tar.gz` if present. Otherwise download `https://github.com/logos-co/logos-logoscore-cli/releases/download/0.2.3/logosctl-aarch64-linux.tar.gz`. **Verify SHA-256 equals `ARCHIVE_SHA256` before extracting**; on mismatch, fail. Extract into `logos/bin` and chmod `0700` the AppImage. Record the AppImage SHA-256 in `status.json` (observed on the spike copy: `dd6529621abf773cde62e5766623f1a0b93e5b8fe4fad5fdc501700e1540487c`).
  3. Run each logosctl call as `LOGOSCTL --config-dir <node> --json …` with env `APPIMAGE_EXTRACT_AND_RUN=1` (FUSE is present, but this matches the adapter's `logosEnv()`). Bound each call to 60 s.
  4. For each node: `daemon status` → if not running, `daemon start --detach`. Then `catalog refresh`. If `package ls --type core` lacks `storage_module 2.1.2`, run `package install storage_module --version 2.1.2 --root-hash 19b11b15…b740 --yes`. Then `module load storage_module` (tolerate already-loaded). Write `storage-init.json` (0600) from `storageInit(...)`, then `call storage_module init @<abs>/storage-init.json` and `call storage_module start`.
  5. `start` is asynchronous. Poll `call storage_module debug` until `result.value.id` is present (deadline 60 s). The peer IDs of A and B must differ.
  6. Replication smoke (current run, new CID). Write 41 random bytes to a mode-0600 temp file under `logos/node-a/`. Run `call storage_module uploadUrl <abs> 65536` on A, and wait for `watch storage_module --event storageUploadDone` with the matching filename (adapter semantics) to get the CID. On B, run `call storage_module connect <peerIdA> json:[]`, then `downloadToUrl <cid> <abs-dest-in-node-b> false 65536`, and wait for `storageDownloadDone` for that CID. Compare the SHA-256 of the bytes. Record `{cidPrefix, digestMatch, bytes}` in `status.json` (this is the doctor's `logos-replication` row). Delete the plaintext temp files.
  7. Merge the `LOGOSCTL`, `LOGOS_NODE_A`, `LOGOS_NODE_B` and `APPIMAGE_EXTRACT_AND_RUN=1` keys into `live.env`.

`logos-down.ts`: for each owned node dir, run `call storage_module stop`, wait for `storageStop` (15 s), run `call storage_module destroy`, then `daemon stop`. Only with `--purge`, remove `storage-data/`.

- [ ] **Step 4: GREEN and live bring-up**

Run: `npx vitest run tests/unit/live-infra-logos.test.ts` → 2 passed.
Run: `node --experimental-strip-types scripts/live-infra/logos-up.ts` → `logos-a=up logos-b=up replication=digest_match`.
Run: `npm run infra:doctor` → `logos-a PASS`, `logos-b PASS`, `logos-replication PASS`.

- [ ] **Step 5: Close plan Task 8's open live item with the existing test**

Run: `set -a; . .runtime/live/live.env; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/storage.test.ts`
Expected: the test **runs** (it is not `ctx.skip()`ed) and passes: fresh 41-byte payload, stop origin, fetch from B, 42-byte rejection, tampered-ciphertext rejection. If it stops origin A, re-run `logos-up.ts` afterwards; step 4 of that script restarts A idempotently. Record the result against plan Task 8 as live evidence. If the existing test does not yet cover all of those cases, that is a Task 8 code gap: report it, and do not treat it as an infrastructure failure.

---

## Task 4: Waku — pin real public-network peers and prove strict mode

**Files:**
- Create: `scripts/live-infra/waku-peers.ts`, `tests/unit/live-infra-waku.test.ts`

**Interfaces:**
- Consumes: `@waku/sdk` 0.0.36 `createLightNode({ defaultBootstrap: true, networkConfig: DefaultNetworkConfig })`, `waitForPeers([Protocols.LightPush, Protocols.Filter])`, and the libp2p peer store on `node.libp2p`.
- Produces: `waku/peers.json` `{ discoveredAt, clusterId: 1, peers: string[] }` and the `live.env` keys `WAKU_BOOTSTRAP_PEERS` and `SSF_WAKU_CONTENT_TOPIC`.

- [ ] **Step 1: Failing test for peer filtering**

```ts
// tests/unit/live-infra-waku.test.ts
import { describe, expect, it } from 'vitest';
import { browserDialable } from '../../scripts/live-infra/waku-peers.ts';

describe('waku-peers', () => {
  it('keeps only secure-websocket multiaddrs that carry a peer id, deduplicated', () => {
    const p = '/p2p/16Uiu2HAmTest';
    expect(browserDialable([
      `/dns4/node-01.example.org/tcp/8000/wss${p}`,
      `/dns4/node-01.example.org/tcp/8000/wss${p}`,
      `/ip4/1.2.3.4/tcp/30303${p}`,
      '/dns4/node-02.example.org/tcp/443/wss',
      `/ip4/127.0.0.1/tcp/8000/ws${p}`,
    ])).toEqual([`/dns4/node-01.example.org/tcp/8000/wss${p}`]);
  });
});
```

- [ ] **Step 2: Run to confirm RED**

Run: `npx vitest run tests/unit/live-infra-waku.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `waku-peers.ts`**
  - `browserDialable(addrs)`: keep entries matching `/\/(dns4|dns6|dnsaddr)\/[^/]+\/tcp\/\d+\/(wss|tls\/ws)\/p2p\/[A-Za-z0-9]+$/`, deduplicated and order-preserving. Plain `ws`, IP-only and peer-id-less addresses are excluded, because browsers under HTTPS need `wss` and the CSP pins hostnames.
  - CLI: create a light node with `defaultBootstrap: true`, and wait for LightPush+Filter peers (90 s). For every connected peer that supports both protocols, read `node.libp2p.peerStore.get(peerId)`, build `${addr.multiaddr}/p2p/${peerId}`, filter with `browserDialable`, and keep at least 2 (fail if fewer, with the count). Write `waku/peers.json` 0600, stop the node, and merge `WAKU_BOOTSTRAP_PEERS` (comma-joined) plus `SSF_WAKU_CONTENT_TOPIC=/sovereign-storefront/1/live/proto` into `live.env`.

- [ ] **Step 4: GREEN and live pinning**

Run: `npx vitest run tests/unit/live-infra-waku.test.ts` → 1 passed.
Run: `node --experimental-strip-types scripts/live-infra/waku-peers.ts` → `waku_peers=<n> cluster=1`.

- [ ] **Step 5: Prove pinned peers alone suffice, in strict mode**

Run: `set -a; . .runtime/live/live.env; set +a; SSF_STRICT_LIVE_WAKU=1 npx vitest run --config vitest.integration.config.ts tests/integration/waku.test.ts`
Expected: 1 passed, not skipped. Because `WAKU_BOOTSTRAP_PEERS` is set, `waku.ts` disables `defaultBootstrap`, so this proves the pinned list works without DNS discovery. Run it 3 times and record the durations. Then run `npm run infra:doctor` → `waku PASS`.

**Risk and fallback:** the public fleet is outside our control. If Step 5 fails intermittently, re-run Step 3 to refresh peers. If it keeps failing, the doctor reports `waku FAIL` in strict mode, and the next step is Task 6 (self-hosted), not a fixture.

---

## Task 5: One-command up/down and the Task 10 handoff

**Files:**
- Create: `scripts/live-infra/up.ts`, `scripts/live-infra/down.ts`, `docs/live-infra.md`
- Modify: `package.json` (add `"infra:up"`, `"infra:down"` using `node --experimental-strip-types`)

- [ ] **Step 1:** `up.ts` runs `zcash-up`, `logos-up` and `waku-peers` in order, then the doctor in strict mode. It exits nonzero if any row is not PASS and prints only row status lines. `down.ts` runs `logos-down`, then `zcash-down`, then checks with `docker ps --filter name=tsz-ssf-live -q` (must be empty), `pgrep -f "logos/node-(a|b)"` and the scanner PID file that nothing owned remains. It never touches `ssf-task1`/`default`/`p-happy`.
- [ ] **Step 2:** Write `docs/live-infra.md`. Include the exact commands (`npm run infra:up`, `npm run infra:doctor`, `SSF_STRICT_LIVE=1 npm run infra:doctor`, `npm run infra:down`), the runtime layout, the `live.env` keys, the "Logos docs vs what we need" table above, and the secret-handling rules. Include no endpoint values, keys, addresses or txids.
- [ ] **Step 3: End-to-end infra acceptance.** Run `npm run infra:down && npm run infra:up`, and expect 6/6 PASS. Then `npm run infra:down`, and confirm nothing owned remains. Then `npm run infra:up` again, which must reach 6/6 PASS (restart safety). Run `npm test && npm run typecheck && npm run build:clean && git diff --check`.
- [ ] **Step 4: Handoff.** Update plan Task 10 with one status note: "Infrastructure available: `npm run infra:up`; consume `.runtime/live/live.env`." Keep the infrastructure running for Task 10's integration subprocess (`dist/service/main.js`) and Task 12. Task 10 still owns: `createLiveAdapters`, `startRuntime`, CSP from `WAKU_BOOTSTRAP_PEERS` hostnames, wiring `createWakuOrderTransport` into `app.ts`, and the `/api/product` and readiness readback.

**Done (whole plan):** `SSF_STRICT_LIVE=1 npm run infra:doctor` exits 0 with zcash, scanner, logos-a, logos-b, logos-replication and waku all PASS from the current run. The Logos two-node integration test ran and was not skipped. The Waku strict integration test passed on pinned peers. A down/up cycle leaves no owned resources behind and comes back green. No secret appears in any tracked file, log excerpt or chat message.

---

## Task 6 (optional, decision-gated): self-hosted Waku node for network independence

Do this only if the user wants the L demo not to depend on the public Waku fleet, or if Task 4 Step 5 cannot be made reliable. Findings that make this non-trivial on this host:

- `wakuorg/nwaku` Docker images (`latest`, `v0.36.0`) are **amd64-only**. On this arm64 host, `exec /usr/bin/wakunode: exec format error` was observed, and binfmt/QEMU is not registered (`docker run --platform linux/amd64 alpine` fails the same way).
- The `logos-delivery` GitHub releases (`v0.39.0-rc.*`, nightly) ship `nwaku` for amd64-linux and arm64-macos only, not arm64-linux.
- `delivery_module` via logosctl defaults to preset `logos.test` = cluster **2**. The app uses cluster **1** (`DefaultNetworkConfig`). The 0.2.1 docs do not document browser WebSocket listener settings for it (`kernelConf` is described as a raw `WakuNodeConf`).

Gated spike (timebox 2 h, report go/no-go before building anything further):
- [ ] Option 6a: build `logosdeliverynode` from `github.com/logos-messaging/logos-delivery` (`make logosdeliverynode`; needs Nim 2.2.6 via `make`, plus Rust) natively on arm64. Run it with relay, filter and lightpush enabled, `--cluster-id=1`, a websocket listener on a loopback port with a local self-signed cert (browser trust needed), and `--staticnode` pointing at itself only. Prove it with `tests/integration/waku.test.ts` using `WAKU_BOOTSTRAP_PEERS=/dns4/localhost/tcp/<port>/wss/p2p/<id>`.
- [ ] Option 6b: register QEMU user emulation (`docker run --privileged --rm tonistiigi/binfmt --install amd64`; this needs root and changes host state, so ask the user first), then run `wakuorg/nwaku:v0.36.0` under emulation with the same flags.
- [ ] Either option requires Task 10 to accept a configured cluster and shard (`src/adapters/waku.ts:90`), which is a code change owned by Task 10, not by infrastructure.

## Self-review

- Spec coverage: L needs actual Waku (Task 4, optional 6), an independently scanned regtest payment (Task 2), two local Logos nodes with origin-stop replica retrieval (Task 3 plus the existing integration test), and a built-app run (handed to Tasks 10/12). T (public testnet) is explicitly out of scope.
- Secrets: the `ths` stdout redirect, UFVK only in 0600 files, doctor evidence limited to prefixes, heights and generations.
- Honesty: every live row is PASS only from a current-run probe. Unreachable means SKIP (lenient) or FAIL (strict), never PASS. The Logos docs' operator requirements are explicitly scoped out, with reasons.
- Names are consistent with plan Task 10: `SSF_SCANNER_SOCKET`, `SSF_SCANNER_ACCOUNT_ID`, `LOGOSCTL`, `LOGOS_NODE_A`, `LOGOS_NODE_B`, `SSF_WAKU_CONTENT_TOPIC`; `WAKU_BOOTSTRAP_PEERS` matches the existing `tests/integration/waku.test.ts`.

## Progress notes

Execution moved to `2026-09-24-live-infra-setup/`; see its ledger.
