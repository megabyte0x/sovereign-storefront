// Task 10.7: the COMPILED entrypoint (dist/service/main.js) against the live
// stack, launched through the same wrapper `npm run start:live` runs
// (scripts/start-live.ts). Gated on SSF_LIVE_RUNTIME=1. When the gate is set,
// every missing precondition FAILS; nothing early-returns as a pass.
//
// This test owns only: its wrapper subprocess, the wrapper's
// dist/service/main.js child, and a fresh .runtime/live/diag/10.7-<ts>/ dir.
// It never runs infra:up/down or ths, and never signals any other process.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { checkDist, LIVE_ENV_PATH, parseEnvText, readLiveEnvFile } from '../../scripts/start-live.ts';
import { SCANNER_JSON } from '../../scripts/live-infra/paths.ts';
import { identityPath, loadOrCreateSellerIdentity } from '../../src/seller/identity.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const START_LIVE = path.join(REPO_ROOT, 'scripts', 'start-live.ts');
const PUBLISH_LIVE = path.join(REPO_ROOT, 'scripts', 'publish-live.ts');
const READY_DEADLINE_MS = 60_000;
const REPLICA_DEADLINE_MS = 120_000;
const STOP_DEADLINE_MS = 10_000;

const enabled = process.env.SSF_LIVE_RUNTIME === '1';

type Started = {
  wrapper: ChildProcess;
  mainPid: number;
  publicUrl: string;
  adminUrl: string;
  ready: string;
};

type Ctx = {
  dir: string;
  dbPath: string;
  tokenFile: string;
  logFile: string;
  publicPort: number;
  adminPort: number;
  version: string;
  sellerKeyId: string;
  peers: string[];
  run?: Started;
};

const ctx = {} as Ctx;

function log(line: string): void {
  if (ctx.logFile) appendFileSync(ctx.logFile, `${line}\n`, { mode: 0o600 });
}

/** `ps` rows for dist/service/main.js, never self-matching the ps/grep/bash wrapper. */
function mainJsProcesses(): { pid: number; ppid: number }[] {
  const out = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).stdout;
  return out
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row.includes('dist/service/main.js') && !row.includes('grep') && !row.includes('bash -c'))
    .map((row) => {
      const [pid, ppid] = row.split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid) };
    });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownedMainJs(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('dist/service/main.js');
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function portRefuses(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Launch the start:live wrapper and wait for public/admin/ready lines. */
async function startLive(): Promise<Started> {
  const env: NodeJS.Dict<string> = {
    ...process.env,
    SSF_DB_PATH: ctx.dbPath,
    SSF_ADMIN_TOKEN_FILE: ctx.tokenFile,
    SSF_SCANNER_CONFIG: SCANNER_JSON,
    SSF_PUBLIC_PORT: String(ctx.publicPort),
    SSF_ADMIN_PORT: String(ctx.adminPort),
  };
  delete env.SSF_ADMIN_TOKEN;
  delete env.SSF_SELLER_KEY_ID;
  delete env.SSF_LIVE_RUNTIME;
  const wrapper = spawn(process.execPath, ['--experimental-strip-types', START_LIVE], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  let buffer = '';
  wrapper.stdout!.setEncoding('utf8');
  wrapper.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      lines.push(line);
      log(`[stdout] ${line}`);
    }
  });
  wrapper.stderr!.setEncoding('utf8');
  wrapper.stderr!.on('data', (chunk: string) => log(`[stderr] ${chunk.trimEnd()}`));

  const deadline = Date.now() + READY_DEADLINE_MS;
  const find = (prefix: string) => lines.find((line) => line.startsWith(prefix));
  while (Date.now() < deadline) {
    if (wrapper.exitCode !== null || wrapper.signalCode !== null) {
      throw new Error(
        `start:live exited early (code=${wrapper.exitCode} signal=${wrapper.signalCode}); last line: ${
          lines.filter((l) => /^(startup failed|run npm|live\.env|cannot)/.test(l)).at(-1) ?? 'n/a'
        }`,
      );
    }
    if (find('ready ')) break;
    await sleep(100);
  }
  const publicLine = find('public ');
  const adminLine = find('admin ');
  const ready = find('ready ');
  if (!publicLine || !adminLine || !ready) {
    wrapper.kill('SIGTERM');
    throw new Error(`no public/admin/ready lines within ${READY_DEADLINE_MS} ms`);
  }
  // Line order contract: public, then admin, then ready.
  expect(lines.indexOf(publicLine)).toBeLessThan(lines.indexOf(adminLine));
  expect(lines.indexOf(adminLine)).toBeLessThan(lines.indexOf(ready));
  const children = mainJsProcesses().filter((p) => p.ppid === wrapper.pid);
  expect(children).toHaveLength(1);
  return {
    wrapper,
    mainPid: children[0]!.pid,
    publicUrl: publicLine.slice('public '.length).trim(),
    adminUrl: adminLine.slice('admin '.length).trim(),
    ready,
  };
}

/** SIGTERM the wrapper (it forwards once to its child) and check exit, ports, PIDs. */
async function stopLive(run: Started): Promise<{ code: number | null; elapsedMs: number }> {
  const started = Date.now();
  const exited = new Promise<number | null>((resolve) => {
    if (run.wrapper.exitCode !== null) resolve(run.wrapper.exitCode);
    else run.wrapper.once('exit', (code) => resolve(code));
  });
  run.wrapper.kill('SIGTERM');
  const code = await Promise.race([exited, sleep(STOP_DEADLINE_MS).then(() => 'timeout' as const)]);
  const elapsedMs = Date.now() - started;
  if (code === 'timeout') throw new Error(`start:live did not exit within ${STOP_DEADLINE_MS} ms`);
  log(`stopped code=${code} elapsedMs=${elapsedMs}`);
  return { code, elapsedMs };
}

async function getJson(url: string): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(url);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: res.status, body, headers: res.headers };
}

/** Expected CSP origin for one Waku multiaddr, mirroring the parser's contract. */
function peerOrigin(peer: string): string {
  const match = /^\/(dns4|dns6|dns|ip4|ip6)\/([^/]+)\/tcp\/(\d+)\/(wss|ws|tls\/ws)(?:\/|$)/.exec(peer);
  if (!match) throw new Error('unparseable WAKU_BOOTSTRAP_PEERS entry');
  const [, proto, host, port, transport] = match;
  const hostPart = proto === 'ip6' ? `[${host}]` : host;
  return `${transport === 'ws' ? 'ws' : 'wss'}://${hostPart}:${port}`;
}

describe.runIf(enabled)('compiled dist/service/main.js against the live stack', () => {
  beforeAll(async () => {
    // Preconditions: each one throws (fails the suite), never skips.
    if (!checkDist(REPO_ROOT)) throw new Error('dist/service/main.js or dist/browser/index.html missing: run npm run build');
    const liveEnv = parseEnvText(readLiveEnvFile(LIVE_ENV_PATH)); // enforces 0600; values never printed
    for (const key of ['SSF_SCANNER_SOCKET', 'WAKU_BOOTSTRAP_PEERS', 'LOGOS_NODE_A', 'LOGOS_NODE_B']) {
      if (!liveEnv[key]) throw new Error(`live.env is missing ${key}: run npm run infra:up`);
    }
    ctx.peers = liveEnv.WAKU_BOOTSTRAP_PEERS!.split(',').map((p) => p.trim()).filter(Boolean);
    if (!existsSync(SCANNER_JSON)) throw new Error('scanner.json missing: run npm run infra:up');
    expect((statSync(SCANNER_JSON).mode & 0o777).toString(8)).toBe('600');
    if (mainJsProcesses().length > 0) throw new Error('a dist/service/main.js is already running; stop it first');

    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    ctx.dir = path.join(REPO_ROOT, '.runtime', 'live', 'diag', `10.7-${ts}`);
    mkdirSync(ctx.dir, { recursive: true, mode: 0o700 });
    ctx.logFile = path.join(ctx.dir, 'runtime.log');
    writeFileSync(ctx.logFile, '', { mode: 0o600 });
    ctx.dbPath = path.join(ctx.dir, 'seller', 'seller.sqlite');
    mkdirSync(path.dirname(ctx.dbPath), { recursive: true, mode: 0o700 });
    ctx.tokenFile = path.join(ctx.dir, 'admin.token');
    writeFileSync(ctx.tokenFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    expect((statSync(ctx.tokenFile).mode & 0o777).toString(8)).toBe('600');
    ctx.publicPort = await freePort();
    ctx.adminPort = await freePort();
    ctx.version = `live-10-7-${ts}`;
  });

  afterAll(async () => {
    // Clean up ONLY what this test started.
    const run = ctx.run;
    if (!run) return;
    if (run.wrapper.exitCode === null && run.wrapper.signalCode === null) {
      run.wrapper.kill('SIGTERM');
      await sleep(STOP_DEADLINE_MS);
    }
    if (alive(run.mainPid) && ownedMainJs(run.mainPid)) {
      try {
        process.kill(-run.mainPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }, 30_000);

  test('first start: readiness lines and live availability before publication', async () => {
    ctx.run = await startLive();
    log(`observed ${ctx.run.ready}`);
    expect(ctx.run.ready).toMatch(/^ready scanner=true messaging=true checkout=(true|false) products=0$/);
    expect(new URL(ctx.run.publicUrl).port).toBe(String(ctx.publicPort));
    expect(new URL(ctx.run.adminUrl).port).toBe(String(ctx.adminPort));
    expect((statSync(ctx.tokenFile).mode & 0o777).toString(8)).toBe('600');

    const availability = await getJson(`${ctx.run.publicUrl}/api/availability`);
    expect(availability.status).toBe(200);
    expect(availability.body).toMatchObject({ scanner: true, messaging: true, productPublished: false });
    const product = await getJson(`${ctx.run.publicUrl}/api/product`);
    expect(product.status).toBe(404);
    const versionAvailability = await getJson(`${ctx.run.publicUrl}/api/availability?productVersion=${ctx.version}`);
    expect(versionAvailability.body).toMatchObject({ productPublished: false, storageReplica: false });
  }, 90_000);

  test('publish one product through scripts/publish-live.ts and reach storageReplica=true', async () => {
    const run = ctx.run!;
    const plaintextFile = path.join(ctx.dir, 'product.txt');
    const plaintext = 'ssf 10.7 live runtime proof\n';
    expect(Buffer.byteLength(plaintext)).toBeLessThanOrEqual(41);
    writeFileSync(plaintextFile, plaintext, { mode: 0o600 });
    const publish = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        PUBLISH_LIVE,
        '--admin-url',
        run.adminUrl,
        '--plaintext-file',
        plaintextFile,
        '--version',
        ctx.version,
        '--amount-zat',
        '100000',
        '--description',
        'Task 10.7 live runtime proof',
      ],
      { cwd: REPO_ROOT, env: { ...process.env, SSF_ADMIN_TOKEN_FILE: ctx.tokenFile }, encoding: 'utf8', timeout: 180_000 },
    );
    log(`[publish] exit=${publish.status} ${publish.stdout.trim()} ${publish.stderr.trim()}`);
    expect(publish.stderr).not.toMatch(/publish failed/);
    expect(publish.status).toBe(0);
    expect(publish.stdout).toMatch(new RegExp(`^published version=${ctx.version} cid=\\S{12}… replica=ok`));

    const deadline = Date.now() + REPLICA_DEADLINE_MS;
    let last: unknown;
    while (Date.now() < deadline) {
      const res = await getJson(`${run.publicUrl}/api/availability?productVersion=${ctx.version}`);
      last = res.body;
      if (res.status === 200 && res.body?.storageReplica === true) break;
      await sleep(2_000);
    }
    log(`[availability] ${JSON.stringify(last)}`);
    expect(last).toMatchObject({ productPublished: true, storageReplica: true, scanner: true, messaging: true });
  }, 330_000);

  test('/api/product reports the published version and the persisted seller identity', async () => {
    const run = ctx.run!;
    expect(existsSync(identityPath(ctx.dbPath))).toBe(true);
    expect((statSync(identityPath(ctx.dbPath)).mode & 0o777).toString(8)).toBe('600');
    const identity = loadOrCreateSellerIdentity(ctx.dbPath);
    ctx.sellerKeyId = identity.publicKeyHex;
    const product = await getJson(`${run.publicUrl}/api/product`);
    expect(product.status).toBe(200);
    expect(product.body.version).toBe(ctx.version);
    expect(product.body.network).toBe('regtest');
    expect(product.body.sellerKeyId).toBe(identity.publicKeyHex);
    log(`sellerKeyId prefix ${String(product.body.sellerKeyId).slice(0, 12)}`);
  });

  test('real-demo disables HTTP checkout/status/recover and pins CSP connect-src to the Waku peers', async () => {
    const run = ctx.run!;
    const statuses: Record<string, number> = {};
    for (const route of ['/api/checkout', '/api/orders', '/api/status', '/api/recover']) {
      const res = await fetch(`${run.publicUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await res.text();
      statuses[route] = res.status;
    }
    log(`[disabled] ${JSON.stringify(statuses)}`);
    expect(statuses).toEqual({ '/api/checkout': 404, '/api/orders': 404, '/api/status': 404, '/api/recover': 404 });

    const res = await fetch(`${run.publicUrl}/`);
    await res.text();
    const csp = res.headers.get('content-security-policy') ?? '';
    const connect = /(?:^|;)\s*connect-src ([^;]*)/.exec(csp)?.[1]?.trim().split(/\s+/) ?? [];
    expect(connect[0]).toBe("'self'");
    expect(connect.join(' ')).not.toContain('*');
    const expected = [...new Set(ctx.peers.map(peerOrigin))];
    expect(expected.length).toBeGreaterThan(0);
    for (const origin of expected) expect(connect).toContain(origin);
    expect(connect.slice(1).sort()).toEqual([...expected].sort());
    for (const origin of connect.slice(1)) expect(origin).toMatch(/^wss:\/\/|^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):/);
    log(`[csp] connect-src entries=${connect.length} wss=${connect.filter((c) => c.startsWith('wss://')).length}`);
  });

  test('SIGTERM exits 0 within 10 s and frees both ports and the child PID', async () => {
    const run = ctx.run!;
    const { code, elapsedMs } = await stopLive(run);
    expect(code).toBe(0);
    expect(elapsedMs).toBeLessThan(STOP_DEADLINE_MS);
    await sleep(200);
    expect(alive(run.mainPid)).toBe(false);
    expect(await portRefuses(ctx.publicPort)).toBe(true);
    expect(await portRefuses(ctx.adminPort)).toBe(true);
    expect(mainJsProcesses()).toEqual([]);
  }, 20_000);

  test('restart on the same DB keeps the seller identity and the published product', async () => {
    ctx.run = await startLive();
    log(`observed restart ${ctx.run.ready}`);
    expect(ctx.run.ready).toMatch(/^ready scanner=true messaging=true checkout=(true|false) products=1$/);
    const product = await getJson(`${ctx.run.publicUrl}/api/product`);
    expect(product.status).toBe(200);
    expect(product.body.version).toBe(ctx.version);
    expect(product.body.sellerKeyId).toBe(ctx.sellerKeyId);
    expect(loadOrCreateSellerIdentity(ctx.dbPath).publicKeyHex).toBe(ctx.sellerKeyId);

    const { code, elapsedMs } = await stopLive(ctx.run);
    expect(code).toBe(0);
    expect(elapsedMs).toBeLessThan(STOP_DEADLINE_MS);
    await sleep(200);
    expect(alive(ctx.run.mainPid)).toBe(false);
    expect(await portRefuses(ctx.publicPort)).toBe(true);
    expect(await portRefuses(ctx.adminPort)).toBe(true);
  }, 90_000);

  test('leak check: no dist/service/main.js left and the live stack is untouched', () => {
    expect(mainJsProcesses()).toEqual([]);
    const doctor = spawnSync('npm', ['run', 'infra:doctor'], {
      cwd: REPO_ROOT,
      env: { ...process.env, SSF_STRICT_LIVE: '1' },
      encoding: 'utf8',
      timeout: 120_000,
    });
    log(`[doctor] exit=${doctor.status} ${doctor.stdout.split('\n').filter((l) => / (PASS|FAIL) /.test(l)).join(' | ')}`);
    expect(doctor.status).toBe(0);
  }, 150_000);
});
