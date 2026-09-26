// R1.4 (Task 11): live coordinated backup/restore proof against the owned
// ssf-live stack. Gated on SSF_LIVE_BACKUP. When the gate is set, every missing
// precondition FAILS; nothing early-returns as a pass.
//
// Gate D1 = (a): this test may stop ONLY the owned scanner `serve` (serve.pid
// plus a /proc cmdline check for the binary and the owned scanner.json) and
// restart it ONLY with `npm run infra:up`. It never runs infra:down or
// `ths stop`, and only talks to the `ssf-live` ths env (faucet + mine).
//
// Owned processes: two seller runs (the start:live wrapper, then a direct
// dist/service/main.js on the restored data), one restored scanner `serve`
// with its own short socket, and one buyer Waku session. Owned dirs: a fresh
// .runtime/live/diag/R1.4-<ts>/ and ~/.local/state/ssf-live/r14-scan-<ts>/.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { bytesToHex } from '@waku/utils/bytes';
import { buildLiveEnv, checkDist, LIVE_ENV_PATH, parseEnvText, readLiveEnvFile } from '../../scripts/start-live.ts';
import { MAX_SOCKET_PATH_BYTES, SCANNER_DIR, SCANNER_JSON } from '../../scripts/live-infra/paths.ts';
import { identityPath, loadOrCreateSellerIdentity } from '../../src/seller/identity.ts';
import { createWakuSession } from '../../src/adapters/waku.ts';
import { createWakuOrderTransport } from '../../src/browser/waku-transport.ts';
import type { BrowserPurchase, CredentialAdapter, Invoice, OrderTransport, PurchaseStore } from '../../src/contracts/types.ts';
import type { WakuSession } from '../../src/contracts/messages.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const START_LIVE = path.join(REPO_ROOT, 'scripts', 'start-live.ts');
const PUBLISH_LIVE = path.join(REPO_ROOT, 'scripts', 'publish-live.ts');
const BACKUP_LIVE = path.join(REPO_ROOT, 'scripts', 'backup-live.ts');
const MAIN_JS = path.join(REPO_ROOT, 'dist', 'service', 'main.js');
const SCANNER_BIN = path.join(REPO_ROOT, 'services', 'scanner', 'target', 'release', 'sovereign-storefront-scanner');
const SERVE_PID = path.join(SCANNER_DIR, 'serve.pid');
const OWNED_THS_ENV = 'ssf-live';
const AMOUNT_ZAT = '100000';
const AMOUNT_ZEC = '0.001';
const READY_DEADLINE_MS = 90_000;
const STOP_DEADLINE_MS = 10_000;

const enabled = Boolean(process.env.SSF_LIVE_BACKUP);

type Seller = { proc: ChildProcess; mainPid: number; publicUrl: string; adminUrl: string; ready: string; kind: 'wrapper' | 'direct' };

type Ctx = {
  dir: string;
  logFile: string;
  ts: string;
  dbPath: string;
  tokenFile: string;
  keyFile: string;
  archive: string;
  restoredSellerDir: string;
  restoredScannerDir: string;
  restoredConfig: string;
  restoredSocket: string;
  version: string;
  sellerKeyId: string;
  logosTmpBefore: number;
  thsEnv: string;
  waku: { contentTopic: string; bootstrapPeers: string[]; peerTimeoutMs: number };
  seller?: Seller;
  restoredScanner?: ChildProcess;
  buyer?: { session: WakuSession; transport: OrderTransport; credentialId: string; purchases: PurchaseStore };
  invoiceA?: Invoice;
  invoiceB?: Invoice;
  packageIdA?: string;
  reservedHighWater?: bigint;
  reserveGap?: bigint;
  preBackupReceivers: Set<string>;
  preBackupIndexes: bigint[];
};

const ctx = { preBackupReceivers: new Set<string>(), preBackupIndexes: [] } as unknown as Ctx;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(line: string): void {
  if (ctx.logFile) appendFileSync(ctx.logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
}

function logosTmpCount(): number {
  const root = process.env.TMPDIR ?? os.tmpdir();
  return readdirSync(root).filter((name) => name.startsWith('ssf-logos-')).length;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

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

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

function socketGetJson(socketPath: string, reqPath: string, timeoutMs = 10_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: reqPath, method: 'GET', headers: { 'content-length': '0' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('scanner socket request timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** Poll `fn` until it returns a value; the timeout error carries the last failure. */
async function pollUntil<T>(label: string, deadlineMs: number, intervalMs: number, fn: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  let last = 'no attempt';
  for (;;) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
      last = 'not yet';
    } catch (error) {
      last = error instanceof Error ? error.message.slice(0, 200) : 'error';
    }
    if (Date.now() > deadline) throw new Error(`${label} not reached within ${deadlineMs} ms (last: ${last})`);
    await sleep(intervalMs);
  }
}

/** Run a command, send its output to the private diag log only, return the exit code and stdout. */
function run(cmd: string, args: string[], opts: { env?: NodeJS.Dict<string>; timeout?: number; label: string }): { code: number | null; stdout: string } {
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, env: opts.env ?? process.env, encoding: 'utf8', timeout: opts.timeout ?? 120_000 });
  log(`[${opts.label}] exit=${res.status}${res.error ? ` error=${res.error.message}` : ''}`);
  log(`[${opts.label}] stdout: ${String(res.stdout ?? '').trim().slice(0, 2_000)}`);
  if (res.stderr) log(`[${opts.label}] stderr: ${String(res.stderr).trim().slice(0, 2_000)}`);
  return { code: res.status, stdout: String(res.stdout ?? '') };
}

function ths(args: string[], label: string): { code: number | null; stdout: string } {
  if (ctx.thsEnv !== OWNED_THS_ENV) throw new Error('refusing a ths call outside the owned ssf-live env');
  return run('ths', [...args.slice(0, 1), '--name', OWNED_THS_ENV, ...args.slice(1)], { label, timeout: 180_000 });
}

function doctorAllPass(label: string): { code: number | null; rows: string[] } {
  const res = run('npm', ['run', 'infra:doctor'], { env: { ...process.env, SSF_STRICT_LIVE: '1' }, timeout: 180_000, label });
  const rows = res.stdout.split('\n').filter((l) => /^(zcash|scanner|logos-a|logos-b|logos-replication|waku) (PASS|FAIL|SKIP)\b/.test(l));
  return { code: res.code, rows };
}

function watchLines(proc: ChildProcess, tag: string): string[] {
  const lines: string[] = [];
  let buffer = '';
  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      lines.push(line);
      log(`[${tag} stdout] ${line}`);
    }
  });
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (chunk: string) => log(`[${tag} stderr] ${chunk.trimEnd().slice(0, 500)}`));
  return lines;
}

async function awaitReady(proc: ChildProcess, lines: string[], tag: string): Promise<{ publicUrl: string; adminUrl: string; ready: string }> {
  const find = (prefix: string) => lines.find((line) => line.startsWith(prefix));
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`${tag} exited early (code=${proc.exitCode} signal=${proc.signalCode}); last: ${lines.filter((l) => /^(startup failed|run npm|live\.env|cannot)/.test(l)).at(-1) ?? 'n/a'}`);
    }
    if (find('ready ')) break;
    await sleep(200);
  }
  const publicLine = find('public ');
  const adminLine = find('admin ');
  const ready = find('ready ');
  if (!publicLine || !adminLine || !ready) {
    proc.kill('SIGTERM');
    throw new Error(`${tag}: no public/admin/ready lines within ${READY_DEADLINE_MS} ms`);
  }
  return { publicUrl: publicLine.slice(7).trim(), adminUrl: adminLine.slice(6).trim(), ready };
}

/** First seller: the real `npm run start:live` wrapper on the live scanner. */
async function startWrapperSeller(): Promise<Seller> {
  const env: NodeJS.Dict<string> = {
    ...process.env,
    SSF_DB_PATH: ctx.dbPath,
    SSF_ADMIN_TOKEN_FILE: ctx.tokenFile,
    SSF_SCANNER_CONFIG: SCANNER_JSON,
    SSF_PUBLIC_PORT: String(await freePort()),
    SSF_ADMIN_PORT: String(await freePort()),
  };
  delete env.SSF_ADMIN_TOKEN;
  delete env.SSF_SELLER_KEY_ID;
  delete env.SSF_LIVE_BACKUP;
  const proc = spawn(process.execPath, ['--experimental-strip-types', START_LIVE], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = watchLines(proc, 'seller1');
  const urls = await awaitReady(proc, lines, 'start:live');
  const children = mainJsProcesses().filter((p) => p.ppid === proc.pid);
  expect(children).toHaveLength(1);
  return { proc, mainPid: children[0]!.pid, ...urls, kind: 'wrapper' };
}

/**
 * Restored seller: the same env start:live builds (buildLiveEnv), but the
 * scanner socket points at the restored scanner. start:live overlays live.env
 * after the caller env, so SSF_SCANNER_SOCKET cannot be redirected through it.
 */
async function startRestoredSeller(dbPath: string): Promise<Seller> {
  const caller: NodeJS.Dict<string> = {
    ...process.env,
    SSF_DB_PATH: dbPath,
    SSF_ADMIN_TOKEN_FILE: ctx.tokenFile,
    SSF_SCANNER_CONFIG: ctx.restoredConfig,
    SSF_PUBLIC_PORT: String(await freePort()),
    SSF_ADMIN_PORT: String(await freePort()),
  };
  delete caller.SSF_LIVE_BACKUP;
  const env = buildLiveEnv(readLiveEnvFile(LIVE_ENV_PATH), caller);
  env.SSF_SCANNER_SOCKET = ctx.restoredSocket;
  expect(env.SSF_ADMIN_TOKEN).toBeUndefined();
  const proc = spawn(process.execPath, [MAIN_JS], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = watchLines(proc, 'seller2');
  const urls = await awaitReady(proc, lines, 'restored main.js');
  return { proc, mainPid: proc.pid!, ...urls, kind: 'direct' };
}

async function stopSeller(seller: Seller): Promise<void> {
  const exited = new Promise<number | null>((resolve) => {
    if (seller.proc.exitCode !== null || seller.proc.signalCode !== null) resolve(seller.proc.exitCode);
    else seller.proc.once('exit', (code) => resolve(code));
  });
  seller.proc.kill('SIGTERM');
  const code = await Promise.race([exited, sleep(STOP_DEADLINE_MS).then(() => 'timeout' as const)]);
  log(`[stop ${seller.kind}] code=${code}`);
  if (code === 'timeout') throw new Error(`${seller.kind} seller did not exit within ${STOP_DEADLINE_MS} ms`);
  expect(code).toBe(0);
  await sleep(300);
  expect(alive(seller.mainPid)).toBe(false);
  for (const url of [seller.publicUrl, seller.adminUrl]) expect(await portRefuses(Number(new URL(url).port))).toBe(true);
}

/** D1 (a): stop ONLY the owned serve, identified by serve.pid + /proc cmdline. */
async function stopOwnedServe(): Promise<number> {
  const pid = Number(readFileSync(SERVE_PID, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('serve.pid is not a pid');
  const c = cmdline(pid);
  const owned = (c.includes('sovereign-storefront-scanner') || c.includes('services/scanner/Cargo.toml'))
    && /(^|\s)serve(\s|$)/.test(c) && c.includes(`--config ${SCANNER_JSON}`);
  if (!owned) throw new Error(`serve.pid ${pid} is not the owned scanner serve; refusing to stop it`);
  process.kill(pid, 'SIGTERM');
  await pollUntil('owned serve exit', 30_000, 250, async () => (alive(pid) ? undefined : true));
  log(`[serve] stopped owned serve pid=${pid}`);
  return pid;
}

/** D1 (a): the only allowed restart path. */
function infraUp(label: string): void {
  const res = run('npm', ['run', 'infra:up'], { timeout: 900_000, label });
  expect(res.code).toBe(0);
  const doctor = doctorAllPass(`${label}-doctor`);
  log(`[${label}-doctor] ${doctor.rows.join(' | ')}`);
  expect(doctor.code).toBe(0);
  expect(doctor.rows.filter((r) => / PASS\b/.test(r))).toHaveLength(6);
}

function memoryPurchaseStore(): PurchaseStore {
  const saved = new Map<string, BrowserPurchase>();
  const deliveries = new Map<string, { packageId: string; wireEnvelope: Uint8Array }>();
  return {
    async save(record) { saved.set(record.requestId, record); },
    async get(requestId) { return saved.get(requestId) ?? null; },
    async list() { return [...saved.values()]; },
    async exportBackup() { throw new Error('not used'); },
    async importBackup() { throw new Error('not used'); },
    async saveDelivery(orderId, record) { deliveries.set(orderId, record); },
    async getDelivery(orderId) { return deliveries.get(orderId) ?? null; },
  };
}

/** Binds one credentialId to the same key the buyer Waku session signs with. */
function buyerCredentials(credentialId: string, publicKeyHex: string): CredentialAdapter {
  const unused = async (): Promise<never> => { throw new Error('not used in this test'); };
  return {
    createPurchaseCredential: unused, provePossession: unused, verifyPossession: unused, decryptWrapped: unused,
    exportBackupMaterial: unused, importBackupMaterial: unused, createWakuSession: unused,
    async publicKey(id: string) {
      if (id !== credentialId) throw new Error('unknown credential');
      return publicKeyHex;
    },
  };
}

async function openBuyer(sellerKeyId: string): Promise<NonNullable<Ctx['buyer']>> {
  const key = generatePrivateKey();
  const buyerKeyId = bytesToHex(getPublicKey(key));
  const credentialId = `cred-${buyerKeyId.slice(0, 16)}`;
  const session = createWakuSession(ctx.waku, key);
  const ready = await session.ready();
  log(`[buyer] waku ready=${ready}`);
  expect(ready).toBe(true);
  const purchases = memoryPurchaseStore();
  const transport = createWakuOrderTransport(buyerCredentials(credentialId, buyerKeyId), session, {
    sellerKeyId, network: 'regtest', amountZat: AMOUNT_ZAT, productVersion: ctx.version,
  }, purchases);
  return { session, transport, credentialId, purchases };
}

async function createInvoice(tag: string): Promise<Invoice> {
  const buyer = ctx.buyer!;
  const record: BrowserPurchase = {
    version: 1, requestId: `r14-${tag}-${ctx.ts}`, orderId: null, productVersion: ctx.version,
    sellerOrigin: 'http://127.0.0.1', sellerKeyId: ctx.sellerKeyId, credentialId: buyer.credentialId, invoice: null,
  };
  const invoice = await buyer.transport.create(record);
  if (invoice.attribution?.kind !== 'receiver') throw new Error(`invoice ${tag} has no receiver attribution`);
  log(`[invoice ${tag}] order=${invoice.orderId.slice(0, 12)} amount=${invoice.amountZat} dIndex=${invoice.attribution.receiver.diversifierIndex}`);
  return invoice;
}

function receiverKey(invoice: Invoice): string {
  if (invoice.attribution?.kind !== 'receiver') throw new Error('no receiver attribution');
  return invoice.attribution.receiver.receiverHex;
}

/** Little-endian 11-byte diversifier index hex -> bigint (same encoding backup-info reports). */
function diversifierIndex(invoice: Invoice): bigint {
  if (invoice.attribution?.kind !== 'receiver') throw new Error('no receiver attribution');
  const bytes = Buffer.from(invoice.attribution.receiver.diversifierIndex, 'hex');
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]!);
  return value;
}

/** Fund one invoice from the ssf-live faucet and mine to at least 10 confirmations. */
function fundAndMine(invoice: Invoice, tag: string): void {
  expect(invoice.amountZat).toBe(AMOUNT_ZAT);
  const faucet = ths(['faucet', '--amount', AMOUNT_ZEC, invoice.destination], `faucet ${tag}`);
  expect(faucet.code).toBe(0);
  const mine = ths(['mine', '10'], `mine ${tag}`);
  expect(mine.code).toBe(0);
}

async function waitConfirmed(orderId: string, tag: string, deadlineMs: number): Promise<void> {
  const buyer = ctx.buyer!;
  let mined = 0;
  const status = await pollUntil(`${tag} confirmed`, deadlineMs, 5_000, async () => {
    const s = await buyer.transport.status(orderId, buyer.credentialId);
    log(`[status ${tag}] payment=${s.payment} delivery=${s.delivery} verification=${JSON.stringify(s.verification).slice(0, 120)}`);
    if (s.payment === 'confirmed') return s;
    // A tx that missed the first mined block needs more depth; mine a bounded few more.
    if (s.payment === 'confirming' && mined < 3) {
      mined += 1;
      ths(['mine', '1'], `mine-extra ${tag}`);
    }
    return undefined;
  });
  expect(status.payment).toBe('confirmed');
}

async function recoverPackageId(orderId: string, tag: string, deadlineMs: number): Promise<string> {
  const buyer = ctx.buyer!;
  return pollUntil(`${tag} recover`, deadlineMs, 5_000, async () => {
    const pkg = await buyer.transport.recover(orderId, buyer.credentialId);
    expect(pkg.orderId).toBe(orderId);
    const stored = await buyer.purchases.getDelivery(orderId);
    if (!stored?.packageId) throw new Error('delivery stored without packageId');
    log(`[recover ${tag}] packageId=${stored.packageId.slice(0, 16)}`);
    return stored.packageId;
  });
}

describe.runIf(enabled)('live coordinated backup/restore (R1.4, gate D1=a)', () => {
  beforeAll(async () => {
    if (!checkDist(REPO_ROOT)) throw new Error('dist/ missing: run npm run build');
    if (!existsSync(SCANNER_BIN)) throw new Error('release scanner binary missing: run npm run infra:up');
    const liveEnv = parseEnvText(readLiveEnvFile(LIVE_ENV_PATH));
    for (const key of ['SSF_SCANNER_SOCKET', 'WAKU_BOOTSTRAP_PEERS', 'SSF_WAKU_CONTENT_TOPIC', 'THS_ENV_NAME']) {
      if (!liveEnv[key]) throw new Error(`live.env is missing ${key}: run npm run infra:up`);
    }
    if (liveEnv.THS_ENV_NAME !== OWNED_THS_ENV) throw new Error('live.env THS_ENV_NAME is not the owned ssf-live env');
    ctx.thsEnv = liveEnv.THS_ENV_NAME;
    ctx.waku = {
      contentTopic: liveEnv.SSF_WAKU_CONTENT_TOPIC!,
      bootstrapPeers: liveEnv.WAKU_BOOTSTRAP_PEERS!.split(',').map((p) => p.trim()).filter(Boolean),
      peerTimeoutMs: 30_000,
    };
    if (!existsSync(SCANNER_JSON) || !existsSync(SERVE_PID)) throw new Error('owned scanner state missing: run npm run infra:up');
    if (mainJsProcesses().length > 0) throw new Error('a dist/service/main.js is already running; stop it first');

    ctx.ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    ctx.dir = path.join(REPO_ROOT, '.runtime', 'live', 'diag', `R1.4-${ctx.ts}`);
    mkdirSync(ctx.dir, { recursive: true, mode: 0o700 });
    ctx.logFile = path.join(ctx.dir, 'live-backup.log');
    writeFileSync(ctx.logFile, '', { mode: 0o600 });
    ctx.dbPath = path.join(ctx.dir, 'seller', 'seller.sqlite');
    mkdirSync(path.dirname(ctx.dbPath), { recursive: true, mode: 0o700 });
    ctx.tokenFile = path.join(ctx.dir, 'admin.token');
    writeFileSync(ctx.tokenFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    ctx.keyFile = path.join(ctx.dir, 'backup.key');
    ctx.archive = path.join(ctx.dir, 'coordinated.ssbk');
    ctx.restoredSellerDir = path.join(ctx.dir, 'restored-seller');
    ctx.restoredScannerDir = path.join(path.dirname(SCANNER_DIR), `r14-${ctx.ts.slice(-6)}`);
    ctx.version = `live-r14-${ctx.ts}`;
    ctx.logosTmpBefore = logosTmpCount();
    log(`[before] ssf-logos-* count=${ctx.logosTmpBefore}`);
  }, 60_000);

  afterAll(async () => {
    // Clean up ONLY what this test started.
    if (!ctx.dir) return;
    await ctx.buyer?.session.close().catch(() => undefined);
    const seller = ctx.seller;
    if (seller && seller.proc.exitCode === null && seller.proc.signalCode === null) {
      seller.proc.kill('SIGTERM');
      await sleep(STOP_DEADLINE_MS);
    }
    if (seller && alive(seller.mainPid) && cmdline(seller.mainPid).includes('dist/service/main.js')) {
      try { process.kill(seller.mainPid, 'SIGKILL'); } catch { /* gone */ }
    }
    const scanner = ctx.restoredScanner;
    if (scanner?.pid && alive(scanner.pid) && cmdline(scanner.pid).includes(ctx.restoredScannerDir)) {
      scanner.kill('SIGTERM');
      await sleep(3_000);
      if (alive(scanner.pid)) scanner.kill('SIGKILL');
    }
    // The restored scanner copy holds viewing-key state; this test created it, so it removes it.
    if (ctx.restoredScannerDir && existsSync(ctx.restoredScannerDir)) rmSync(ctx.restoredScannerDir, { recursive: true, force: true });
  }, 60_000);

  test('before: strict doctor 6/6 PASS and the owned serve is identified by serve.pid + cmdline', () => {
    const doctor = doctorAllPass('doctor-before');
    log(`[doctor-before] ${doctor.rows.join(' | ')}`);
    expect(doctor.code).toBe(0);
    expect(doctor.rows.filter((r) => / PASS\b/.test(r))).toHaveLength(6);
    const pid = Number(readFileSync(SERVE_PID, 'utf8').trim());
    expect(alive(pid)).toBe(true);
    expect(cmdline(pid)).toContain(`serve --config ${SCANNER_JSON}`);
    log(`[before] serve pid=${pid}`);
  }, 200_000);

  test('seller 1: publish, two equal-price invoices over Waku, fund A to 10 confirmations, recover A', async () => {
    ctx.seller = await startWrapperSeller();
    log(`[seller1] ${ctx.seller.ready}`);
    expect(ctx.seller.ready).toMatch(/^ready scanner=true messaging=true /);

    const plaintextFile = path.join(ctx.dir, 'product.txt');
    writeFileSync(plaintextFile, 'ssf R1.4 live backup proof\n', { mode: 0o600 });
    const publish = run(process.execPath, [
      '--experimental-strip-types', PUBLISH_LIVE, '--admin-url', ctx.seller.adminUrl, '--plaintext-file', plaintextFile,
      '--version', ctx.version, '--amount-zat', AMOUNT_ZAT, '--description', 'R1.4 live backup proof',
    ], { env: { ...process.env, SSF_ADMIN_TOKEN_FILE: ctx.tokenFile }, timeout: 180_000, label: 'publish' });
    expect(publish.code).toBe(0);
    expect(publish.stdout).toMatch(/replica=ok/);
    const url = `${ctx.seller.publicUrl}/api/availability?productVersion=${ctx.version}`;
    await pollUntil('storageReplica', 120_000, 2_000, async () => {
      const res = await getJson(url);
      return res.body?.storageReplica === true && res.body?.scanner === true && res.body?.messaging === true ? true : undefined;
    });

    const product = await getJson(`${ctx.seller.publicUrl}/api/product`);
    expect(product.status).toBe(200);
    ctx.sellerKeyId = product.body.sellerKeyId;
    expect(ctx.sellerKeyId).toBe(loadOrCreateSellerIdentity(ctx.dbPath).publicKeyHex);

    ctx.buyer = await openBuyer(ctx.sellerKeyId);
    ctx.invoiceA = await createInvoice('A');
    ctx.invoiceB = await createInvoice('B');
    expect(ctx.invoiceA.amountZat).toBe(ctx.invoiceB.amountZat);
    expect(receiverKey(ctx.invoiceA)).not.toBe(receiverKey(ctx.invoiceB));
    for (const inv of [ctx.invoiceA, ctx.invoiceB]) {
      ctx.preBackupReceivers.add(receiverKey(inv));
      ctx.preBackupIndexes.push(diversifierIndex(inv));
    }

    fundAndMine(ctx.invoiceA, 'A');
    await waitConfirmed(ctx.invoiceA.orderId, 'A', 300_000);
    ctx.packageIdA = await recoverPackageId(ctx.invoiceA.orderId, 'A', 180_000);
    expect(ctx.packageIdA).toMatch(/\S{8,}/);
    const statusB = await ctx.buyer.transport.status(ctx.invoiceB.orderId, ctx.buyer.credentialId);
    expect(statusB.payment).toBe('awaiting');

    await stopSeller(ctx.seller);
    ctx.seller = undefined;
  }, 900_000);

  test('backup: stop only the owned serve, export v2, restart via infra:up to 6/6', async () => {
    await stopOwnedServe();
    const exp = run(process.execPath, [
      '--experimental-strip-types', BACKUP_LIVE, 'export', '--seller-db', ctx.dbPath, '--key-file', ctx.keyFile, '--out', ctx.archive,
    ], { timeout: 180_000, label: 'backup-export' });
    // Restart the live scanner before asserting, so a failed export never leaves it down.
    infraUp('infra-up-after-export');
    expect(exp.code).toBe(0);
    expect(exp.stdout).toMatch(/^version: 2$/m);
    expect(exp.stdout).toMatch(/^entries: 5$/m);
    const hw = /^reservedHighWater: (\d+)$/m.exec(exp.stdout);
    expect(hw).not.toBeNull();
    ctx.reservedHighWater = BigInt(hw![1]!);
    for (const index of ctx.preBackupIndexes) expect(index).toBeLessThanOrEqual(ctx.reservedHighWater);
    expect((statSync(ctx.keyFile).mode & 0o777).toString(8)).toBe('600');
  }, 1_200_000);

  test('while restored seller is stopped: pay invoice B on chain', async () => {
    fundAndMine(ctx.invoiceB!, 'B');
  }, 400_000);

  test('restore into fresh dirs, restore-ack, start the restored scanner and seller', async () => {
    const restore = run(process.execPath, [
      '--experimental-strip-types', BACKUP_LIVE, 'restore', '--archive', ctx.archive, '--key-file', ctx.keyFile,
      '--seller-dir', ctx.restoredSellerDir, '--scanner-dir', ctx.restoredScannerDir,
    ], { timeout: 180_000, label: 'backup-restore' });
    expect(restore.code).toBe(0);
    expect(restore.stdout).toMatch(/restore-ack --config/);
    ctx.restoredConfig = path.join(ctx.restoredScannerDir, path.basename(SCANNER_JSON));
    ctx.restoredSocket = path.join(ctx.restoredScannerDir, `.${path.basename(SCANNER_JSON)}.live-state`, 'scanner.sock');
    expect(Buffer.byteLength(ctx.restoredSocket)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    expect(existsSync(ctx.restoredConfig)).toBe(true);

    // The printed command carries the reserve gap; use the same suggested value.
    const gap = /restore-ack --config \S+ --new-epoch --reserve-gap (\d+)/.exec(restore.stdout);
    expect(gap).not.toBeNull();
    ctx.reserveGap = BigInt(gap![1]!);
    expect(ctx.reserveGap > 0n).toBe(true);
    // Serve before the acknowledgement must refuse the restored state.
    const early = run(SCANNER_BIN, ['serve', '--config', ctx.restoredConfig], { timeout: 60_000, label: 'serve-before-ack' });
    // Exit 1 (refused), not null (a timeout would mean it served unacknowledged state).
    expect(early.code).toBe(1);
    const ack = run(SCANNER_BIN, [
      'restore-ack', '--config', ctx.restoredConfig, '--new-epoch', '--reserve-gap', ctx.reserveGap.toString(),
    ], { timeout: 120_000, label: 'restore-ack' });
    expect(ack.code).toBe(0);
    expect(ack.stdout).toContain('scanner_restore_acknowledged');

    const scanner = spawn(SCANNER_BIN, ['serve', '--config', ctx.restoredConfig], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    ctx.restoredScanner = scanner;
    watchLines(scanner, 'scanner2');
    await pollUntil('restored scanner ready', 300_000, 2_000, async () => {
      if (scanner.exitCode !== null) throw new Error(`restored scanner exited code=${scanner.exitCode}`);
      const snap = await socketGetJson(ctx.restoredSocket, '/v1/snapshot');
      return snap?.complete === true && snap?.health === 'ready' ? snap : undefined;
    });

    const restoredDb = path.join(ctx.restoredSellerDir, path.basename(ctx.dbPath));
    expect(existsSync(identityPath(restoredDb))).toBe(true);
    ctx.seller = await startRestoredSeller(restoredDb);
    log(`[seller2] ${ctx.seller.ready}`);
    expect(ctx.seller.ready).toMatch(/^ready scanner=true messaging=true /);
  }, 600_000);

  test('restored: same identity, same packageId for A, B discovered, next receiver is fresh', async () => {
    const restoredDb = path.join(ctx.restoredSellerDir, path.basename(ctx.dbPath));
    expect(loadOrCreateSellerIdentity(restoredDb).publicKeyHex).toBe(ctx.sellerKeyId);
    const product = await getJson(`${ctx.seller!.publicUrl}/api/product`);
    expect(product.status).toBe(200);
    expect(product.body.sellerKeyId).toBe(ctx.sellerKeyId);
    expect(product.body.version).toBe(ctx.version);

    // Invoice A replays from the restored seller over the same Waku transport
    // (same requestId -> the stored invoice): identical terms.
    const restoredA = await createInvoice('A');
    const terms = (inv: Invoice) => ({
      orderId: inv.orderId, amountZat: inv.amountZat, productVersion: inv.productVersion,
      destination: inv.destination, paymentUri: inv.paymentUri, receiver: receiverKey(inv),
      diversifierIndex: diversifierIndex(inv),
    });
    expect(terms(restoredA)).toEqual(terms(ctx.invoiceA!));
    expect(restoredA).toEqual(ctx.invoiceA);

    // Recover A: identical packageId with no new payment for A.
    const packageId = await recoverPackageId(ctx.invoiceA!.orderId, 'A-restored', 300_000);
    expect(packageId).toBe(ctx.packageIdA);

    // B was paid while the restored seller was stopped; the restored stack discovers it.
    await waitConfirmed(ctx.invoiceB!.orderId, 'B-restored', 300_000);

    // The next allocation must not reuse any pre-backup receiver.
    await pollUntil('storageReplica (restored)', 120_000, 2_000, async () => {
      const res = await getJson(`${ctx.seller!.publicUrl}/api/availability?productVersion=${ctx.version}`);
      return res.body?.storageReplica === true ? true : undefined;
    });
    const invoiceC = await createInvoice('C');
    expect(ctx.preBackupReceivers.has(receiverKey(invoiceC))).toBe(false);
    expect(diversifierIndex(invoiceC) > ctx.reservedHighWater!).toBe(true);
    // The reserve gap burns every index the original could have issued after the backup.
    expect(diversifierIndex(invoiceC) > ctx.reservedHighWater! + ctx.reserveGap! - 1n).toBe(true);
  }, 900_000);

  test('after: stop everything this test started; doctor 6/6, no leaked process/port/temp dir', async () => {
    await ctx.buyer?.session.close();
    ctx.buyer = undefined;
    if (ctx.seller) {
      await stopSeller(ctx.seller);
      ctx.seller = undefined;
    }
    const scanner = ctx.restoredScanner!;
    const exited = new Promise<void>((resolve) => {
      if (scanner.exitCode !== null || scanner.signalCode !== null) resolve();
      else scanner.once('exit', () => resolve());
    });
    scanner.kill('SIGTERM');
    await Promise.race([exited, sleep(15_000)]);
    expect(alive(scanner.pid!)).toBe(false);
    rmSync(ctx.restoredScannerDir, { recursive: true, force: true });
    expect(existsSync(ctx.restoredSocket)).toBe(false);

    expect(mainJsProcesses()).toEqual([]);
    const doctor = doctorAllPass('doctor-after');
    log(`[doctor-after] ${doctor.rows.join(' | ')}`);
    expect(doctor.code).toBe(0);
    expect(doctor.rows.filter((r) => / PASS\b/.test(r))).toHaveLength(6);
    const after = logosTmpCount();
    log(`[after] ssf-logos-* count=${after} before=${ctx.logosTmpBefore}`);
    expect(after).toBeLessThanOrEqual(ctx.logosTmpBefore);
  }, 300_000);
});
