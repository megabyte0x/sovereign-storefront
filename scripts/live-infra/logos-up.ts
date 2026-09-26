import { existsSync, statSync, readFileSync, writeFileSync, chmodSync, rmSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_ROOT, ensurePrivateDir, mergeLiveEnv } from './paths.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(__dirname, '../..');
// Reuse the already-verified spike download when present, so a normal
// bring-up never needs network access to GitHub.
const SPIKE_ARCHIVE = path.resolve(
  WORKTREE_ROOT,
  '..',
  'feat-mvp-t2/spikes/storage/runtime/logosctl-aarch64-linux.tar.gz',
);
const ARCHIVE_URL = 'https://github.com/logos-co/logos-logoscore-cli/releases/download/0.2.3/logosctl-aarch64-linux.tar.gz';
export const ARCHIVE_SHA256 = 'f1ed1debcac20a9943ae2786021f574e439af42f853db0e753a365acb45eb3c3';
const STORAGE_MODULE_VERSION = '2.1.2';
const STORAGE_ROOT_HASH = '19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740';

const LOGOS_ROOT = path.join(LIVE_ROOT, 'logos');
const NODE_A = { dir: path.join(LOGOS_ROOT, 'node-a'), listenPort: 18091, discPort: 18090 };
const NODE_B = { dir: path.join(LOGOS_ROOT, 'node-b'), listenPort: 18191, discPort: 18190 };

/**
 * Build the fixed-port, node-separated `storage_module` init config for one
 * node directory. `dir` must be absolute so the resulting config never
 * depends on the process's current working directory.
 */
export function storageInit(dir: string, listenPort: number, discPort: number): Record<string, unknown> {
  if (!path.isAbsolute(dir)) {
    throw new Error(`storage dir must be absolute: ${dir}`);
  }
  return {
    'data-dir': `${dir}/storage-data`,
    'log-file': `${dir}/storage-data/storage.log`,
    'log-level': 'INFO',
    'listen-port': listenPort,
    'disc-port': discPort,
    network: 'logos.test',
  };
}

const PREFIX_LEN = 12;

export type ReplicationProof = {
  provedAt: string;
  nodeAPeerIdPrefix: string;
  nodeBPeerIdPrefix: string;
  cidPrefix: string;
  bytes: number;
  digestMatch: boolean;
  daemonStartedAt: { a: string; b: string };
};

/**
 * Serialize the replication proof written to `LOGOS_ROOT/replication.json`.
 * Only prefixes (<= 12 chars) of the CID and peer IDs are ever recorded.
 */
export function replicationProof(input: {
  provedAt: string;
  peerIdA: string;
  peerIdB: string;
  cidPrefix: string;
  bytes: number;
  digestMatch: boolean;
  daemonStartedAt: { a: string; b: string };
}): ReplicationProof {
  if (input.cidPrefix.length === 0 || input.cidPrefix.length > PREFIX_LEN) {
    throw new Error(`cid prefix must be 1-${PREFIX_LEN} characters`);
  }
  return {
    provedAt: input.provedAt,
    nodeAPeerIdPrefix: input.peerIdA.slice(0, PREFIX_LEN),
    nodeBPeerIdPrefix: input.peerIdB.slice(0, PREFIX_LEN),
    cidPrefix: input.cidPrefix,
    bytes: input.bytes,
    digestMatch: input.digestMatch,
    daemonStartedAt: input.daemonStartedAt,
  };
}

/**
 * Identity of a running logosctl daemon: `<started_at>#pid<pid>`.
 *
 * `logosctl --json daemon status` only reports `daemon.status` in the shape we
 * rely on; the daemon itself records `pid` and `started_at` (ISO) in
 * `<config-dir>/daemon/state.json` (observed in the storage spike runtime).
 * We use that file rather than `/proc/<pid>/stat`, and require the recorded
 * pid to be alive so a stale state file from a dead daemon yields undefined.
 * A restart changes both fields, so equality means "same daemon instance".
 */
export function daemonIdentity(stateJson: string, isAlive: (pid: number) => boolean): string | undefined {
  let state: any;
  try { state = JSON.parse(stateJson); } catch { return undefined; }
  const pid = state?.pid;
  const startedAt = state?.started_at;
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof startedAt !== 'string' || startedAt === '') return undefined;
  if (!isAlive(pid)) return undefined;
  return `${startedAt}#pid${pid}`;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Read the current daemon identity for one node config dir, or undefined. */
export function readDaemonIdentity(configDir: string): string | undefined {
  const statePath = path.join(configDir, 'daemon', 'state.json');
  if (!existsSync(statePath)) return undefined;
  try {
    return daemonIdentity(readFileSync(statePath, 'utf8'), pidAlive);
  } catch {
    return undefined;
  }
}

/**
 * Parse `logosctl --json daemon status` stdout. logosctl 0.2.3 exits 1 while
 * still printing valid JSON (e.g. `not_configured` before the first start),
 * so callers must read stdout regardless of the exit code.
 */
export function parseDaemonStatus(stdout: string): string | undefined {
  try {
    const status = JSON.parse(stdout.trim())?.daemon?.status;
    return typeof status === 'string' ? status : undefined;
  } catch {
    return undefined;
  }
}

/** CID of the manifest whose filename matches, from a `call storage_module manifests` response. */
export function cidFromManifests(resp: any, filename: string): string | undefined {
  const list = resp?.result?.value;
  if (!Array.isArray(list)) return undefined;
  const match = list.find((m: any) => m?.filename === filename && typeof m?.cid === 'string');
  return match?.cid;
}

/** Atomic 0600 write: tmp file, fsync, rename. */
export function writeFileAtomic0600(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.tmp`;
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Live bring-up (not exercised by unit tests)
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(fn: () => Promise<T | undefined>, deadlineMs: number, label: string, intervalMs = 2_000): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const result = await fn().catch(() => undefined);
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`${label} did not become ready within ${deadlineMs}ms`);
    await sleep(intervalMs);
  }
}

async function retry<T>(fn: () => Promise<T>, attempts: number, delayMs = 3_000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}

function execPlain(cmd: string, args: string[], ms = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cmd} ${args.join(' ')} timed out`)), ms);
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err) { reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`)); return; }
      resolve({ stdout, stderr });
    });
  });
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function execFileEnv(cmd: string, args: string[], env: NodeJS.ProcessEnv, ms: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cmd} ${args.join(' ')} timed out`)), ms);
    execFile(cmd, args, { env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      // logosctl --json reports errors on stdout; keep a bounded tail of it.
      if (err) { reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message} stdout=${stdout.trim().slice(-500)}`)); return; }
      resolve({ stdout, stderr });
    });
  });
}

const LOGOSCTL_ENV = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' };

/** One bounded, JSON `logosctl` call scoped to a single node's config dir. */
async function callJson(logosctlPath: string, configDir: string, args: string[], ms = 60_000): Promise<any> {
  const { stdout } = await execFileEnv(
    logosctlPath,
    ['--config-dir', configDir, '--json', ...args],
    LOGOSCTL_ENV,
    ms,
  );
  return JSON.parse(stdout.trim());
}

/** `daemon status` tolerant of logosctl's non-zero exit for non-running states. */
function daemonStatus(logosctlPath: string, configDir: string, ms = 60_000): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${configDir} daemon status timed out`)), ms);
    execFile(
      logosctlPath,
      ['--config-dir', configDir, '--json', 'daemon', 'status'],
      { env: LOGOSCTL_ENV, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        const status = parseDaemonStatus(stdout);
        if (status !== undefined) { resolve(status); return; }
        reject(new Error(`${configDir} daemon status failed: ${stderr || err?.message || 'unparseable output'}`));
      },
    );
  });
}

async function ensureArchive(): Promise<string> {
  const binDir = path.join(LOGOS_ROOT, 'bin');
  ensurePrivateDir(binDir);
  const appImagePath = path.join(binDir, 'logosctl-aarch64.AppImage');
  if (existsSync(appImagePath)) return appImagePath;

  let archivePath = SPIKE_ARCHIVE;
  let tmpArchive: string | undefined;
  if (!existsSync(SPIKE_ARCHIVE)) {
    const res = await fetch(ARCHIVE_URL);
    if (!res.ok) throw new Error(`failed to download logosctl archive: HTTP ${res.status}`);
    tmpArchive = path.join(binDir, 'logosctl-aarch64-linux.tar.gz.download');
    writeFileSync(tmpArchive, Buffer.from(await res.arrayBuffer()));
    archivePath = tmpArchive;
  }

  const digest = sha256File(archivePath);
  if (digest !== ARCHIVE_SHA256) {
    throw new Error(`logosctl archive digest mismatch: expected ${ARCHIVE_SHA256}, got ${digest}`);
  }

  await execPlain('tar', ['xzf', archivePath, '-C', binDir], 30_000);
  if (tmpArchive && existsSync(tmpArchive)) rmSync(tmpArchive);
  chmodSync(appImagePath, 0o700);
  return appImagePath;
}

export async function bringUpNode(
  logosctlPath: string,
  node: { dir: string; listenPort: number; discPort: number },
): Promise<{ peerId: string }> {
  ensurePrivateDir(node.dir);
  ensurePrivateDir(path.join(node.dir, 'storage-data'));

  const status = await daemonStatus(logosctlPath, node.dir);
  if (status !== 'running') {
    await execFileEnv(
      logosctlPath,
      ['--config-dir', node.dir, '--json', 'daemon', 'start', '--detach'],
      LOGOSCTL_ENV,
      30_000,
    );
    await pollUntil(
      async () => {
        const s = await daemonStatus(logosctlPath, node.dir);
        return s === 'running' ? s : undefined;
      },
      30_000,
      `${node.dir} daemon start`,
      1_000,
    );
  }

  const installed = await callJson(logosctlPath, node.dir, ['package', 'ls', '--type', 'core']);
  const hasStorageModule = Array.isArray(installed)
    && installed.some((p: any) => p.name === 'storage_module' && p.version === STORAGE_MODULE_VERSION);
  if (!hasStorageModule) {
    // The catalog fetch hits GitHub; package_downloader's RPC intermittently
    // fails after ~20 s (RPC_FAILED) and succeeds on a later attempt. Only
    // needed when the module is missing, so idempotent re-runs skip it.
    await retry(() => callJson(logosctlPath, node.dir, ['catalog', 'refresh'], 45_000), 6, 5_000);
    await retry(() => callJson(
      logosctlPath,
      node.dir,
      ['package', 'install', 'storage_module', '--version', STORAGE_MODULE_VERSION, '--root-hash', STORAGE_ROOT_HASH, '--yes'],
      60_000,
    ), 3);
  }

  // Idempotent: logosctl reports {status:"ok"} whether or not it was already loaded.
  await callJson(logosctlPath, node.dir, ['module', 'load', 'storage_module']);

  const initPath = path.join(node.dir, 'storage-init.json');
  writeFileSync(initPath, `${JSON.stringify(storageInit(node.dir, node.listenPort, node.discPort))}\n`, { mode: 0o600 });
  chmodSync(initPath, 0o600);

  const debugBefore = await callJson(logosctlPath, node.dir, ['call', 'storage_module', 'debug']).catch(() => undefined);
  if (!debugBefore?.result?.value?.id) {
    await callJson(logosctlPath, node.dir, ['call', 'storage_module', 'init', `@${initPath}`]);
    await callJson(logosctlPath, node.dir, ['call', 'storage_module', 'start']);
  }

  const debug = await pollUntil(
    async () => {
      const d = await callJson(logosctlPath, node.dir, ['call', 'storage_module', 'debug']);
      return d?.result?.value?.id ? d : undefined;
    },
    60_000,
    `${node.dir} storage_module peer id`,
    2_000,
  );

  return { peerId: debug.result.value.id };
}

function watchEvents(logosctlPath: string, configDir: string, eventName: string): { stop: () => void; lines: () => string[] } {
  const child = spawn(
    logosctlPath,
    ['--config-dir', configDir, '--json', 'watch', 'storage_module', '--event', eventName],
    // Own process group: the AppImage wrapper leaves the real logosctl as a
    // grandchild, so stop() must signal the whole group.
    { env: LOGOSCTL_ENV, detached: true },
  );
  let buffer = '';
  child.stdout.on('data', (c) => { buffer += c; });
  return {
    // `logosctl watch` was observed live to survive SIGTERM, and its open
    // stdout pipe then kept this process alive; force-kill and detach.
    stop: () => {
      child.stdout.destroy();
      child.stderr?.destroy();
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      child.unref();
    },
    lines: () => buffer.split('\n').filter((l) => l.trim() !== ''),
  };
}

function parseEventPayload(line: string): any {
  const evt = JSON.parse(line);
  return { event: evt.event, data: JSON.parse(evt.data.arg0) };
}

async function replicationSmoke(
  logosctlPath: string,
  nodeA: { dir: string; listenPort: number },
  nodeB: { dir: string },
  peerIdA: string,
): Promise<{ cidPrefix: string; digestMatch: boolean; bytes: number }> {
  const bytes = randomBytes(41);
  const expectedDigest = createHash('sha256').update(bytes).digest('hex');
  const srcPath = path.join(nodeA.dir, `smoke-${Date.now()}.bin`);
  const destPath = path.join(nodeB.dir, `smoke-${Date.now()}-downloaded.bin`);
  writeFileSync(srcPath, bytes, { mode: 0o600 });
  chmodSync(srcPath, 0o600);

  const uploadWatch = watchEvents(logosctlPath, nodeA.dir, 'storageUploadDone');
  try {
    // Give the watch subscription time to attach (the spike sleeps 500 ms).
    await sleep(1_000);
    const upload = await callJson(logosctlPath, nodeA.dir, ['call', 'storage_module', 'uploadUrl', srcPath, '65536'], 30_000);
    if (upload?.result?.success !== true) throw new Error(`uploadUrl failed: ${JSON.stringify(upload)}`);
    const sessionId = String(upload.result.value);

    const cid = await pollUntil(
      async () => {
        for (const line of uploadWatch.lines()) {
          try {
            const { event, data } = parseEventPayload(line);
            if (event === 'storageUploadDone' && String(data.sessionId) === sessionId && data.success) {
              return data.cid as string;
            }
          } catch { /* ignore non-JSON / unrelated lines */ }
        }
        // Fallback when the watch line is missed: the manifest list is the
        // durable completion record (same check the spike uses).
        const manifests = await callJson(logosctlPath, nodeA.dir, ['call', 'storage_module', 'manifests']);
        return cidFromManifests(manifests, path.basename(srcPath));
      },
      60_000,
      'storageUploadDone event',
      1_000,
    );

    // `call storage_module connect <peerId> json:[]` (empty address hint)
    // fails DHT discovery for two loopback-only nodes within any reasonable
    // deadline ("peer not found") — confirmed against a live pair of nodes.
    // Supplying the explicit loopback multiaddr connects immediately.
    const addr = `/ip4/127.0.0.1/tcp/${nodeA.listenPort}/p2p/${peerIdA}`;
    await callJson(logosctlPath, nodeB.dir, ['call', 'storage_module', 'connect', peerIdA, `json:[${JSON.stringify(addr)}]`], 30_000);

    const downloadWatch = watchEvents(logosctlPath, nodeB.dir, 'storageDownloadDone');
    try {
      await sleep(1_000);
      // Mirror the storage spike: fetch the manifest on B first and wait for
      // it to be listed. A downloadToUrl issued immediately after `connect`
      // was observed live to fail with "Failed to start download." while the
      // same call succeeded moments later, so it is also retried.
      await retry(async () => {
        const m = await callJson(logosctlPath, nodeB.dir, ['call', 'storage_module', 'downloadManifest', cid], 30_000);
        if (m?.result?.success === false) throw new Error(`downloadManifest failed: ${JSON.stringify(m)}`);
      }, 3);
      await pollUntil(
        async () => {
          const m = await callJson(logosctlPath, nodeB.dir, ['call', 'storage_module', 'manifests']);
          return Array.isArray(m?.result?.value) && m.result.value.some((x: any) => x.cid === cid) ? true : undefined;
        },
        60_000,
        'manifest on node-b',
        2_000,
      );
      await retry(async () => {
        const download = await callJson(
          logosctlPath,
          nodeB.dir,
          ['call', 'storage_module', 'downloadToUrl', cid, destPath, 'false', '65536'],
          30_000,
        );
        if (download?.result?.success !== true) throw new Error(`downloadToUrl failed: ${JSON.stringify(download)}`);
      }, 4);

      await pollUntil(
        async () => {
          // Existence alone races the writer (observed live: digest mismatch
          // on a partially written file). Require the full byte count.
          if (existsSync(destPath) && statSync(destPath).size === bytes.length) return true;
          return undefined;
        },
        30_000,
        'storageDownloadDone event',
        1_000,
      );
    } finally {
      downloadWatch.stop();
    }

    if (!existsSync(destPath)) throw new Error('download did not produce a file');
    const downloaded = readFileSync(destPath);
    const digestMatch = createHash('sha256').update(downloaded).digest('hex') === expectedDigest;
    return { cidPrefix: cid.slice(0, 12), digestMatch, bytes: bytes.length };
  } finally {
    uploadWatch.stop();
    if (existsSync(srcPath)) rmSync(srcPath);
    if (existsSync(destPath)) rmSync(destPath);
  }
}

async function main(): Promise<void> {
  ensurePrivateDir(LIVE_ROOT);
  ensurePrivateDir(LOGOS_ROOT);

  const logosctlPath = await ensureArchive();

  const [a, b] = await Promise.all([bringUpNode(logosctlPath, NODE_A), bringUpNode(logosctlPath, NODE_B)]);
  if (a.peerId === b.peerId) throw new Error('logos node A and B report the same peer id');

  const replication = await replicationSmoke(logosctlPath, NODE_A, NODE_B, a.peerId);

  const startedA = readDaemonIdentity(NODE_A.dir);
  const startedB = readDaemonIdentity(NODE_B.dir);
  if (!startedA || !startedB) throw new Error('could not read logos daemon identity (daemon/state.json pid/started_at)');
  const proof = replicationProof({
    provedAt: new Date().toISOString(),
    peerIdA: a.peerId,
    peerIdB: b.peerId,
    ...replication,
    daemonStartedAt: { a: startedA, b: startedB },
  });
  writeFileAtomic0600(path.join(LOGOS_ROOT, 'replication.json'), `${JSON.stringify(proof, null, 2)}\n`);

  const statusPath = path.join(LOGOS_ROOT, 'status.json');
  writeFileSync(
    statusPath,
    `${JSON.stringify({ appImageSha256: sha256File(logosctlPath), peerIdA: a.peerId, peerIdB: b.peerId }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(statusPath, 0o600);

  mergeLiveEnv({
    LOGOSCTL: logosctlPath,
    LOGOS_NODE_A: NODE_A.dir,
    LOGOS_NODE_B: NODE_B.dir,
    APPIMAGE_EXTRACT_AND_RUN: '1',
  });

  process.stdout.write(`logos-a=up logos-b=up replication=${replication.digestMatch ? 'digest_match' : 'digest_mismatch'}\n`);
  if (!replication.digestMatch) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`logos-up failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}
