import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { LIVE_ROOT, MAX_SOCKET_PATH_BYTES, ensurePrivateDir } from './paths.ts';
import { readDaemonIdentity } from './logos-up.ts';

export type RowId = 'zcash' | 'scanner' | 'logos-a' | 'logos-b' | 'logos-replication' | 'waku';

export type Row = {
  id: RowId;
  status: 'PASS' | 'FAIL' | 'SKIP';
  reason: string;
  evidence?: Record<string, string | number | boolean>;
};

/** Parse `KEY=value` lines, ignoring blank lines and `#` comments. */
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

/** Turn a tri-state probe outcome into a Row status. Unreachable is never PASS. */
export function classify(ok: boolean | undefined, reason: string, strict: boolean): Pick<Row, 'status' | 'reason'> {
  if (ok === true) return { status: 'PASS', reason };
  if (ok === false) return { status: 'FAIL', reason };
  return { status: strict ? 'FAIL' : 'SKIP', reason };
}

/**
 * A socket path over 100 bytes cannot be connected to by absolute path
 * (sun_path limit 108). That is a configuration error, so it FAILs in both
 * strict and lenient modes rather than being treated as unreachable.
 */
export function checkSocketPath(p: string): Pick<Row, 'status' | 'reason'> | undefined {
  if (Buffer.byteLength(p) > MAX_SOCKET_PATH_BYTES) return { status: 'FAIL', reason: 'socket path too long' };
  return undefined;
}

/** Overall doctor verdict. Strict mode treats any SKIP as failure too. */
export function summarize(rows: { status: string }[], strict: boolean): { ok: boolean; exitCode: 0 | 1 } {
  const bad = rows.some((r) => r.status === 'FAIL' || (strict && r.status === 'SKIP'));
  return { ok: !bad, exitCode: bad ? 1 : 0 };
}

export type DaemonIdentity = { peerIdPrefix: string; startedAt: string };

/**
 * Judge `LIVE_ROOT/logos/replication.json` against the daemons running now.
 * "Current run" = both nodes' daemon identity and peer-ID prefix equal the
 * recorded ones. `current` is undefined when either daemon is not running.
 */
export function replicationVerdict(
  proof: unknown,
  current: { a: DaemonIdentity; b: DaemonIdentity } | undefined,
  strict: boolean,
): Pick<Row, 'status' | 'reason' | 'evidence'> {
  const p = proof as any;
  const wellFormed = p !== null && typeof p === 'object'
    && typeof p.provedAt === 'string'
    && typeof p.nodeAPeerIdPrefix === 'string' && typeof p.nodeBPeerIdPrefix === 'string'
    && typeof p.cidPrefix === 'string' && p.cidPrefix.length > 0 && p.cidPrefix.length <= 12
    && typeof p.bytes === 'number' && typeof p.digestMatch === 'boolean'
    && typeof p.daemonStartedAt?.a === 'string' && typeof p.daemonStartedAt?.b === 'string';
  if (!wellFormed) return classify(undefined, 'not yet proven this run', strict);
  if (p.digestMatch !== true) return { status: 'FAIL', reason: 'digest mismatch' };
  const fresh = current !== undefined
    && current.a.startedAt === p.daemonStartedAt.a && current.b.startedAt === p.daemonStartedAt.b
    && current.a.peerIdPrefix === p.nodeAPeerIdPrefix && current.b.peerIdPrefix === p.nodeBPeerIdPrefix;
  if (!fresh) return classify(undefined, 'replication proof predates current daemons', strict);
  return { status: 'PASS', reason: 'ok', evidence: { cidPrefix: p.cidPrefix, bytes: p.bytes } };
}

// ---------------------------------------------------------------------------
// CLI-only section below: live probes against real infrastructure.
// Not exercised by unit tests; exercised live once infra is up (Tasks 2-4).
// ---------------------------------------------------------------------------

const SCANNER_MAX_AGE_MS = 120_000;
const SCANNER_CLOCK_SKEW_MS = 5_000;

/**
 * The scanner daemon stamps `checkedAt` in unix **seconds** (Rust
 * `as_secs()`), so it must be scaled before comparing with `Date.now()`.
 * A stamp from the future (beyond small skew) or older than 120 s is stale.
 */
export function scannerSnapshotFresh(checkedAt: unknown, nowMs: number): boolean {
  if (typeof checkedAt !== 'number' || !Number.isSafeInteger(checkedAt)) return false;
  const checkedAtMs = checkedAt * 1_000;
  return checkedAtMs <= nowMs + SCANNER_CLOCK_SKEW_MS && nowMs - checkedAtMs <= SCANNER_MAX_AGE_MS;
}

const PROBE_DEADLINE_MS = 15_000;
// Spawns a real subprocess (vitest) that dials the public Waku fleet; give it
// materially more room than the other in-process probes.
const WAKU_PROBE_DEADLINE_MS = 120_000;

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function execJson(cmd: string, args: string[], ms: number): Promise<any> {
  return withDeadline(
    new Promise((resolve, reject) => {
      execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) { reject(err); return; }
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
    }),
    ms,
    `${cmd} ${args.join(' ')}`,
  );
}

function httpGetJson(socketPath: string, reqPath: string, ms: number): Promise<any> {
  return withDeadline(
    new Promise((resolve, reject) => {
      // The scanner's hand-rolled HTTP parser requires an explicit
      // Content-Length even on a bodyless GET, or it replies 400 request_malformed.
      const req = http.request({ socketPath, path: reqPath, method: 'GET', headers: { 'content-length': '0' } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.end();
    }),
    ms,
    `GET ${reqPath}`,
  );
}

async function probeEnvValue(env: Record<string, string>, key: string, strict: boolean): Promise<{ ok: boolean; reason: string; value?: string }> {
  const value = env[key];
  if (!value) return { ok: false, reason: `LIVE_ENV missing ${key}` };
  return { ok: true, reason: 'present', value };
}

async function probeZcash(env: Record<string, string>, strict: boolean): Promise<Row> {
  const id: RowId = 'zcash';
  const nameCheck = await probeEnvValue(env, 'THS_ENV_NAME', strict);
  if (!nameCheck.value) return { id, ...classify(undefined, nameCheck.reason, strict) };
  const envName = nameCheck.value;
  try {
    const status = await execJson('ths', ['status', '--name', envName, '--json'], PROBE_DEADLINE_MS);
    if (status?.running !== true) {
      return { id, ...classify(false, 'ths status running=false', strict) };
    }
    const endpoints = await execJson('ths', ['endpoints', '--name', envName, '--json'], PROBE_DEADLINE_MS);
    const rpc = endpoints?.rpc;
    if (!rpc) return { id, ...classify(false, 'no rpc endpoint published', strict) };
    // JSON-RPC getblockchaininfo
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'doctor', method: 'getblockchaininfo', params: [] });
    const info: any = await withDeadline(
      fetch(rpc, { method: 'POST', body, headers: { 'content-type': 'application/json' } }).then((r) => r.json()),
      PROBE_DEADLINE_MS,
      'getblockchaininfo',
    );
    const blocks = info?.result?.blocks;
    if (typeof blocks !== 'number') return { id, ...classify(false, 'getblockchaininfo missing blocks', strict) };
    return { id, status: 'PASS', reason: 'ok', evidence: { blocks } };
  } catch (e: any) {
    return { id, ...classify(undefined, `probe error: ${e.message}`, strict) };
  }
}

async function probeScanner(env: Record<string, string>, strict: boolean): Promise<Row> {
  const id: RowId = 'scanner';
  const sockCheck = await probeEnvValue(env, 'SSF_SCANNER_SOCKET', strict);
  if (!sockCheck.value) return { id, ...classify(undefined, sockCheck.reason, strict) };
  const sockPathCheck = checkSocketPath(sockCheck.value);
  if (sockPathCheck) return { id, ...sockPathCheck };
  if (!existsSync(sockCheck.value)) return { id, ...classify(undefined, 'socket missing', strict) };
  try {
    const snap = await httpGetJson(sockCheck.value, '/v1/snapshot', PROBE_DEADLINE_MS);
    const fresh = scannerSnapshotFresh(snap?.checkedAt, Date.now());
    const ok = snap?.complete === true && snap?.health === 'ready' && fresh;
    if (!ok) {
      return { id, ...classify(false, `health=${snap?.health ?? 'unavailable'} complete=${snap?.complete === true} fresh=${fresh}`, strict) };
    }
    return {
      id,
      status: 'PASS',
      reason: 'ok',
      evidence: { generation: snap.generation, 'tip.height': snap?.tip?.height, accountId: snap.accountId },
    };
  } catch (e: any) {
    return { id, ...classify(undefined, `probe error: ${e.message}`, strict) };
  }
}

async function probeLogosNode(id: 'logos-a' | 'logos-b', dir: string, env: Record<string, string>, strict: boolean): Promise<Row> {
  const logosctlCheck = await probeEnvValue(env, 'LOGOSCTL', strict);
  if (!logosctlCheck.value) return { id, ...classify(undefined, logosctlCheck.reason, strict) };
  const nodeDirCheck = await probeEnvValue(env, dir, strict);
  if (!nodeDirCheck.value) return { id, ...classify(undefined, nodeDirCheck.reason, strict) };
  try {
    const out = await execJson(
      logosctlCheck.value,
      ['--config-dir', nodeDirCheck.value, '--json', 'call', 'storage_module', 'debug'],
      PROBE_DEADLINE_MS,
    );
    const peerId: string | undefined = out?.result?.value?.id;
    if (typeof peerId !== 'string' || peerId.length === 0) {
      return { id, ...classify(false, 'no peer id reported', strict) };
    }
    return { id, status: 'PASS', reason: 'ok', evidence: { peerIdPrefix: peerId.slice(0, 12) } };
  } catch (e: any) {
    return { id, ...classify(undefined, `probe error: ${e.message}`, strict) };
  }
}

async function probeLogosReplication(env: Record<string, string>, nodeRows: Row[], strict: boolean): Promise<Row> {
  const id: RowId = 'logos-replication';
  const proofPath = path.join(LIVE_ROOT, 'logos', 'replication.json');
  let proof: unknown;
  try {
    if (existsSync(proofPath)) proof = JSON.parse(readFileSync(proofPath, 'utf8'));
  } catch {
    proof = undefined;
  }
  // Current identity is computed exactly as logos-up.ts records it:
  // peer-ID prefix from the live `storage_module debug` probe, daemon identity
  // from <node-dir>/daemon/state.json (pid must be alive).
  const identity = (row: Row | undefined, dirKey: string): DaemonIdentity | undefined => {
    const peerIdPrefix = row?.status === 'PASS' ? row.evidence?.peerIdPrefix : undefined;
    const dir = env[dirKey];
    const startedAt = dir ? readDaemonIdentity(dir) : undefined;
    return typeof peerIdPrefix === 'string' && startedAt ? { peerIdPrefix, startedAt } : undefined;
  };
  const a = identity(nodeRows.find((r) => r.id === 'logos-a'), 'LOGOS_NODE_A');
  const b = identity(nodeRows.find((r) => r.id === 'logos-b'), 'LOGOS_NODE_B');
  return { id, ...replicationVerdict(proof, a && b ? { a, b } : undefined, strict) };
}

async function probeWaku(env: Record<string, string>, strict: boolean): Promise<Row> {
  const id: RowId = 'waku';
  const peersCheck = await probeEnvValue(env, 'WAKU_BOOTSTRAP_PEERS', strict);
  if (!peersCheck.value) return { id, ...classify(undefined, peersCheck.reason, strict) };
  try {
    const out: string = await withDeadline(
      new Promise((resolve, reject) => {
        execFile(
          'npx',
          ['vitest', 'run', '--config', 'vitest.integration.config.ts', 'tests/integration/waku.test.ts', '--reporter=json'],
          {
            maxBuffer: 32 * 1024 * 1024,
            env: { ...process.env, WAKU_BOOTSTRAP_PEERS: peersCheck.value, SSF_STRICT_LIVE_WAKU: '1' },
          },
          (err, stdout) => {
            // vitest exits non-zero on failed suites; still parse stdout if present.
            resolve(stdout ?? '');
            void err;
          },
        );
      }),
      WAKU_PROBE_DEADLINE_MS,
      'waku integration test',
    );
    const jsonStart = out.indexOf('{');
    if (jsonStart < 0) return { id, ...classify(false, 'no json reporter output', strict) };
    const report = JSON.parse(out.slice(jsonStart));
    const passed = report?.numPassedTests === 1;
    return passed
      ? { id, status: 'PASS', reason: 'ok', evidence: { numPassedTests: report.numPassedTests } }
      : { id, ...classify(false, `numPassedTests=${report?.numPassedTests ?? 0}`, strict) };
  } catch (e: any) {
    return { id, ...classify(undefined, `probe error: ${e.message}`, strict) };
  }
}

async function runProbes(strict: boolean): Promise<Row[]> {
  const envPath = path.join(LIVE_ROOT, 'live.env');
  const env = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};

  const rows: Row[] = [];
  rows.push(await probeZcash(env, strict));
  rows.push(await probeScanner(env, strict));
  const logosA = await probeLogosNode('logos-a', 'LOGOS_NODE_A', env, strict);
  const logosB = await probeLogosNode('logos-b', 'LOGOS_NODE_B', env, strict);
  rows.push(logosA, logosB);
  rows.push(await probeLogosReplication(env, [logosA, logosB], strict));
  rows.push(await probeWaku(env, strict));
  return rows;
}

async function main(): Promise<void> {
  const strict = process.env.SSF_STRICT_LIVE === '1';
  ensurePrivateDir(LIVE_ROOT);
  const rows = await runProbes(strict);
  const summary = summarize(rows, strict);

  const statusPath = path.join(LIVE_ROOT, 'status.json');
  const tmpPath = `${statusPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ generatedAt: new Date().toISOString(), strict, rows, summary }, null, 2), {
    mode: 0o600,
  });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, statusPath);

  for (const row of rows) {
    process.stdout.write(`${row.id} ${row.status} ${row.reason}\n`);
  }
  process.exitCode = summary.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`doctor failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}
