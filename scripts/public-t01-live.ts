// Live adapters and CLI for the public T01 runner (scripts/public-t01.ts).
//   node --experimental-strip-types scripts/public-t01-live.ts preflight|dry-run|run|status|finalize|verify-report
// Browser: a dedicated persistent Chromium profile per purchase under ignored
// .runtime/public/t01-profiles/. Wallet: scripts/public-t01-wallet.ts. Seller
// scanner and VPS services: the authorized `tailscale ssh root@ssf-replica` path. The
// independent checker: the local view-only scanner socket. Nothing here prints a
// receiver, payment URI, key or bearer secret.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import * as jsQrModule from 'jsqr';
import { validateSnapshot } from '../src/contracts/live-validation.ts';
import type { ScanSnapshot } from '../src/contracts/live.ts';
import { collectPublicCapture } from './live-observe.ts';
import { validateLiveReport } from './live-report.ts';
import { FEE_RESERVE_ZAT, MAX_SENDS, runPublicT01Wallet } from './public-t01-wallet.ts';
import {
  finalizeT01,
  runT01,
  type BrowserDriver,
  type InvoiceView,
  type RunState,
  type SendResult,
  type T01Deps,
} from './public-t01.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, '.runtime/public');
const STATE_FILE = path.join(RUNTIME, 't01-run.json');
const PROFILES = process.env.SSF_T01_PROFILES ?? path.join(RUNTIME, 't01-profiles');
const DOWNLOADS = path.join(RUNTIME, 't01-downloads');
const REPORT = path.join(RUNTIME, 'report.json');
const FIXTURES = path.join(RUNTIME, 'fixtures/fixtures.json');
const CHECKER_SOCKET = path.join(os.homedir(), '.local/state/ssf-public/checker/.scanner.json.live-state/scanner.sock');

export const PUBLIC_ORIGIN = 'https://store.agentmascot.app';
export const EMBED_ORIGIN = 'https://sovereign-store.pages.dev';
const PRODUCTS = ['gift-of-the-magi', 'yellow-wallpaper'] as const;
const AMOUNT_ZAT = '100000';
const PI = 'root@ssf-replica';
const COMPOSE = 'cd /srv/ssf/deploy && docker compose -p ssf-public -f compose.vps.yaml --env-file /srv/ssf/public-testnet.env';
const DB_NAME = 'sovereign-storefront-purchases';

type JsQrFn = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const decodeQr: JsQrFn = typeof jsQrModule === 'function'
  ? jsQrModule as unknown as JsQrFn
  : (jsQrModule as unknown as { default: JsQrFn }).default;

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function browserProfileDir(dir: string): void {
  privateDir(dir);
  const user = process.env.SSF_T01_BROWSER_USER;
  if (!user) return;
  const root = path.resolve(PROFILES);
  const profile = path.resolve(dir);
  if (!/^[a-z_][a-z0-9_-]*$/.test(user) || !profile.startsWith(`${root}${path.sep}`)) {
    throw new Error('browser profile path or user is invalid');
  }
  const result = spawnSync('chown', ['-R', `${user}:${user}`, root]);
  if (result.status !== 0 || result.error) throw new Error('browser profile ownership could not be set');
}

function writePrivateJson(file: string, value: unknown): void {
  privateDir(path.dirname(file));
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/** Rasterize the storefront's rect-based QR SVG (same approach as tests/public/smoke.spec.ts). */
export function rasterizeSvg(svg: string): { width: number; height: number; data: Uint8ClampedArray } {
  const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  if (!viewBox) throw new Error('svg missing viewBox');
  const width = Number(viewBox[1]);
  const height = Number(viewBox[2]);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const match of svg.matchAll(/<rect\b([^>]*?)\/?>/g)) {
    const attrs = match[1] ?? '';
    if (!/fill="#111"/.test(attrs)) continue;
    const num = (name: string) => Number(attrs.match(new RegExp(`(?:^|\\s)${name}="(\\d+)"`))?.[1] ?? NaN);
    const [x0, y0, w, h] = [num('x'), num('y'), num('width'), num('height')];
    if ([x0, y0, w, h].some(Number.isNaN)) continue;
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) {
        const idx = (y * width + x) * 4;
        data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

type StoredRow = { requestId: string; orderId: string | null; productVersion: string; invoice: { paymentUri?: string } | null };

/** Read purchase rows without creating the database in a profile that has none. */
async function readPurchases(page: Page): Promise<StoredRow[]> {
  // Runs in the page. The scripts' tsconfig has no DOM lib, so the IndexedDB
  // surface is described with minimal local types.
  type Req<T> = { result: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null };
  type Db = {
    objectStoreNames: { contains(name: string): boolean };
    transaction(name: string, mode: string): { objectStore(name: string): { getAll(): Req<unknown[]> } };
    close(): void;
  };
  type Factory = { open(name: string): Req<Db>; databases?: () => Promise<Array<{ name?: string }>> };
  return page.evaluate(async (dbName) => {
    const idb = (globalThis as unknown as { indexedDB: Factory }).indexedDB;
    const done = <T>(request: Req<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const known = (await idb.databases?.()) ?? [];
    if (!known.some((db) => db.name === dbName)) return [];
    const db = await done(idb.open(dbName));
    try {
      if (!db.objectStoreNames.contains('purchases')) return [];
      const rows = await done(db.transaction('purchases', 'readonly').objectStore('purchases').getAll());
      return rows.map((row) => {
        const r = row as { requestId: string; orderId: string | null; productVersion: string; invoice: { paymentUri?: string } | null };
        return { requestId: r.requestId, orderId: r.orderId, productVersion: r.productVersion, invoice: r.invoice ? { paymentUri: r.invoice.paymentUri } : null };
      });
    } finally {
      db.close();
    }
  }, DB_NAME);
}

export function createPlaywrightDriver(options: { headless?: boolean } = {}): BrowserDriver & { closeAll(): Promise<void> } {
  const contexts = new Map<string, BrowserContext>();
  const open = async (profile: string): Promise<BrowserContext> => {
    const existing = contexts.get(profile);
    if (existing) return existing;
    browserProfileDir(profile);
    const browserDownloads = path.join(PROFILES, '.downloads');
    browserProfileDir(browserDownloads);
    const context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.SSF_T01_CHROMIUM ?? '/usr/bin/chromium',
      headless: options.headless ?? true,
      chromiumSandbox: true,
      acceptDownloads: true,
      downloadsPath: browserDownloads,
      args: ['--disable-dev-shm-usage'],
    });
    contexts.set(profile, context);
    return context;
  };
  const withPage = async <T>(profile: string, fn: (page: Page) => Promise<T>): Promise<T> => {
    const page = await (await open(profile)).newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  };
  const openPurchases = async (page: Page): Promise<void> => {
    await page.goto(`${PUBLIC_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('#nav-purchases').first().click();
    await page.locator('#view-purchases').waitFor({ timeout: 30_000 });
  };
  const openOrder = async (page: Page, requestId: string): Promise<string> => {
    await openPurchases(page);
    await page.locator(`button[data-request-id="${requestId}"]`).click();
    const label = page.locator('#payment-label');
    await label.waitFor({ timeout: 120_000 });
    return (await label.textContent())?.trim() ?? '';
  };

  return {
    async openInvoice(profile, productVersion): Promise<InvoiceView> {
      return withPage(profile, async (page) => {
        await page.goto(`${EMBED_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
        const buy = page.locator(`ssf-buy[product="${productVersion}"]`).getByRole('button', { name: 'Buy' });
        await buy.waitFor({ timeout: 30_000 });
        const popupPromise = page.waitForEvent('popup');
        await buy.click();
        const popup = await popupPromise;
        try {
          await popup.waitForURL(new RegExp(`/p/${productVersion}`));
          const before = new Set((await readPurchases(popup)).map((row) => row.requestId));
          await popup.getByRole('button', { name: 'Buy' }).click();
          const uriEl = popup.locator('#zip321-uri');
          await uriEl.waitFor({ timeout: 150_000 });
          const shown = (await uriEl.textContent())?.trim() ?? '';
          const svg = await popup.locator('[data-zip321-qr] svg').evaluate((el) => (el as unknown as { outerHTML: string }).outerHTML);
          const bitmap = rasterizeSvg(svg);
          const qr = decodeQr(bitmap.data, bitmap.width, bitmap.height)?.data ?? '';
          const created = (await readPurchases(popup)).filter((row) => !before.has(row.requestId)
            && row.productVersion === productVersion && row.orderId && row.invoice?.paymentUri);
          if (created.length !== 1) throw new Error('expected exactly one new persisted invoice');
          const row = created[0]!;
          if (row.invoice?.paymentUri !== shown) throw new Error('rendered URI differs from the persisted invoice');
          return { requestId: row.requestId, orderId: row.orderId!, uri: shown, qr };
        } finally {
          await popup.close().catch(() => undefined);
        }
      });
    },
    async relaunch(profile) {
      const context = contexts.get(profile);
      contexts.delete(profile);
      await context?.close();
      await open(profile);
    },
    async purchase(profile, requestId) {
      return withPage(profile, async (page) => {
        await openPurchases(page);
        const listed = await page.locator(`button[data-request-id="${requestId}"]`).count();
        const row = (await readPurchases(page)).find((candidate) => candidate.requestId === requestId);
        if (listed !== 1 || !row?.orderId || !row.invoice?.paymentUri) return null;
        return { requestId, orderId: row.orderId, uri: row.invoice.paymentUri };
      });
    },
    async exportBackup(profile, requestId) {
      return withPage(profile, async (page) => {
        await openPurchases(page);
        const wanted = `purchase-${requestId}.backup`;
        const found = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('backup download not produced')), 30_000);
          page.on('download', (download) => {
            if (download.suggestedFilename() !== wanted) return;
            clearTimeout(timer);
            privateDir(DOWNLOADS);
            const target = path.join(DOWNLOADS, wanted);
            void download.saveAs(target).then(() => { chmodSync(target, 0o600); resolve(target); }, reject);
          });
        });
        await page.locator('#export-backup').click();
        return found;
      });
    },
    async importBackup(profile, file) {
      await withPage(profile, async (page) => {
        await openPurchases(page);
        await page.locator('#import-backup').setInputFiles({
          name: path.basename(file),
          mimeType: 'application/octet-stream',
          buffer: readFileSync(file),
        });
        const status = page.locator('#import-status');
        await status.filter({ hasText: 'Backup imported' }).waitFor({ timeout: 30_000 });
        if ((await status.textContent())?.trim() !== 'Backup imported') throw new Error('backup import refused');
      });
    },
    async paymentState(profile, requestId) {
      return withPage(profile, async (page) => ((await openOrder(page, requestId)) === 'Paid' ? 'confirmed' : 'awaiting'));
    },
    async download(profile, requestId) {
      return withPage(profile, async (page) => {
        const downloaded = page.waitForEvent('download', { timeout: 180_000 }).catch(() => null);
        if ((await openOrder(page, requestId)) !== 'Paid') return null;
        const orderId = (await readPurchases(page)).find((row) => row.requestId === requestId)?.orderId;
        if (!orderId) return null;
        const download = await downloaded;
        if (!download || !download.suggestedFilename().endsWith('.bin')) return null;
        privateDir(DOWNLOADS);
        const target = path.join(DOWNLOADS, `${requestId}-${Date.now()}.bin`);
        await download.saveAs(target);
        chmodSync(target, 0o600);
        const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
        // The storefront sends its Waku acknowledgement after starting the
        // download. Keep the page and its transport alive until the seller
        // records it; closing here can cancel an otherwise valid ack.
        return (await waitForSellerAcknowledgement(orderId)) ? digest : null;
      });
    },
    async closeAll() {
      for (const context of contexts.values()) await context.close().catch(() => undefined);
      contexts.clear();
    },
  };
}

function ssh(script: string, timeoutMs = 120_000): { code: number; stdout: string } {
  const local = process.env.SSF_T01_LOCAL_VPS === '1';
  const result = spawnSync(local ? 'sh' : 'tailscale', local ? ['-s'] : ['ssh', PI, 'sh', '-s'], {
    input: script, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  });
  return { code: result.error || result.signal ? 1 : result.status ?? 1, stdout: result.stdout ?? '' };
}

async function waitForSellerAcknowledgement(orderId: string): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(orderId)) return false;
  const script = `set -eu
docker exec -i ssf-public-seller-1 node -e '
const fs=require("fs");const {DatabaseSync}=require("node:sqlite");
const env=Object.fromEntries(fs.readFileSync(process.env.SSF_ENV_FILE,"utf8").split(/\\n/).filter(line=>line.includes("=")).map(line=>[line.slice(0,line.indexOf("=")),line.slice(line.indexOf("=")+1)]));
const db=new DatabaseSync(env.SSF_DB_PATH,{readOnly:true});
const row=db.prepare("SELECT state FROM delivery_state WHERE order_id=?").get("${orderId}");
process.stdout.write(row?.state==="acknowledged"?"yes":"no");'
`;
  const deadline = Date.now() + 60_000;
  do {
    const result = ssh(script, 10_000);
    if (result.code === 0 && result.stdout.trim() === 'yes') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (true);
}

const SELLER_SNAPSHOT_SCRIPT = String.raw`set -eu
docker exec -i ssf-public-seller-1 node -e '
const http=require("http");const fs=require("fs");
const env=Object.fromEntries(fs.readFileSync(process.env.SSF_ENV_FILE,"utf8").split(/\n/).filter(l=>l.includes("=")).map(l=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1)]));
const r=http.request({socketPath:env.SSF_SCANNER_SOCKET,path:"/v1/snapshot",method:"GET",headers:{"content-length":0}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>{if(res.statusCode!==200)process.exit(1);process.stdout.write(b)})});
r.on("error",()=>process.exit(1));r.end();'
`;

export async function sellerSnapshot(): Promise<ScanSnapshot> {
  const result = ssh(SELLER_SNAPSHOT_SCRIPT, 60_000);
  if (result.code !== 0) throw new Error('seller scanner snapshot unavailable');
  return validateSnapshot(JSON.parse(result.stdout));
}

export function checkerSnapshot(socketPath = CHECKER_SOCKET): Promise<ScanSnapshot> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: '/v1/snapshot', method: 'GET', headers: { 'content-length': 0 } }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('checker snapshot unavailable');
          resolve(validateSnapshot(JSON.parse(body)));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(20_000, () => request.destroy(new Error('checker snapshot timeout')));
    request.end();
  });
}

const PI_SERVICES = new Set(['seller', 'logos-a']);
const pi: T01Deps['pi'] = {
  async stop(service) {
    if (!PI_SERVICES.has(service)) throw new Error('refusing unknown service');
    if (ssh(`set -eu\n${COMPOSE} stop ${service}\n`).code !== 0) throw new Error(`compose stop ${service} failed`);
  },
  async start(service) {
    if (!PI_SERVICES.has(service)) throw new Error('refusing unknown service');
    if (ssh(`set -eu\n${COMPOSE} start ${service}\n`).code !== 0) throw new Error(`compose start ${service} failed`);
  },
  async healthy() {
    const result = ssh('set -eu\nfor c in seller scanner logos-a; do docker inspect -f "{{.State.Health.Status}}" ssf-public-$c-1; done\n', 30_000);
    const statuses = result.stdout.trim().split(/\s+/);
    if (result.code !== 0 || statuses.length !== 3 || statuses.some((status) => status !== 'healthy')) return false;
    const response = await fetch(`${PUBLIC_ORIGIN}/api/products`).catch(() => null);
    return response?.status === 200;
  },
};

export type WalletSendOptions = {
  /** Delay between `resolve` polls after an unknown broadcast outcome (default 30 s). */
  pollIntervalMs?: number;
  /** Total time spent polling before giving up as ambiguous (default 15 min). */
  pollBudgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  ledgerPath?: string;
  run?: typeof runPublicT01Wallet;
};

/** Read-only view of the send ledger's record for one invoice (sha256(uri), same digest as the wallet script). */
function ledgerRecordFor(ledgerPath: string, uri: string): { status?: unknown; txid?: unknown } | null {
  if (!existsSync(ledgerPath)) return null;
  const digest = createHash('sha256').update(uri).digest('hex');
  try {
    const sends = (JSON.parse(readFileSync(ledgerPath, 'utf8')) as { sends?: unknown } | null)?.sends;
    if (!Array.isArray(sends)) return null;
    const matches = sends.filter((send) => (send as { invoiceDigest?: unknown } | null)?.invoiceDigest === digest);
    return (matches.at(-1) as { status?: unknown; txid?: unknown } | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function walletSend(uri: string, options: WalletSendOptions = {}): Promise<SendResult> {
  const run = options.run ?? runPublicT01Wallet;
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['send', '--uri', uri], { stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
  if (code === 0) {
    const txid = (JSON.parse(out.join('')) as { txid?: unknown }).txid;
    return typeof txid === 'string' ? { kind: 'sent', txid } : { kind: 'ambiguous' };
  }
  if (code === 3) {
    // Broadcast outcome unknown: poll `resolve` (which only rebroadcasts the identical
    // bytes or checks chain state) and trust the ledger. Never build a second send.
    const interval = options.pollIntervalMs ?? 30_000;
    const budget = options.pollBudgetMs ?? 15 * 60_000;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const ledgerPath = options.ledgerPath ?? path.join(RUNTIME, 'buyer-sends.json');
    const polls = interval > 0 ? Math.floor(budget / interval) : 0;
    for (let poll = 0; poll < polls; poll += 1) {
      await sleep(interval);
      await run(['resolve'], { stdout: () => undefined, stderr: () => undefined }).catch(() => 3);
      const record = ledgerRecordFor(ledgerPath, uri);
      if (record?.status === 'sent' && typeof record.txid === 'string') return { kind: 'sent', txid: record.txid };
      if (record?.status === 'expired') break;
    }
    return { kind: 'ambiguous' };
  }
  return { kind: 'refused', reason: err.join('').replace(/^BLOCKED: /, '').trim() };
}

async function walletStatus(): Promise<{ spendableZat: bigint; sends: number; pending: number; remaining: number } | null> {
  const out: string[] = [];
  const code = await runPublicT01Wallet(['status'], { stdout: (text) => out.push(text), stderr: () => undefined });
  if (code !== 0) return null;
  const parsed = JSON.parse(out.join('')) as { spendableZat: string; sends: number; pending: number; remaining: number };
  return { ...parsed, spendableZat: BigInt(parsed.spendableZat) };
}

function observe(args: string[]): Promise<number> {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', path.join(ROOT, 'scripts/live-observe.ts'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  return Promise.resolve(result.error || result.signal ? 1 : result.status ?? 1);
}

function loadState(): RunState | null {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RunState : null;
}

function fixtures(): Record<string, string> {
  const raw = JSON.parse(readFileSync(FIXTURES, 'utf8')) as Record<string, { sha256: string }>;
  return Object.fromEntries(PRODUCTS.map((product) => {
    const digest = raw[product]?.sha256;
    if (!digest || !/^[0-9a-f]{64}$/.test(digest)) throw new Error(`fixture digest missing for ${product}`);
    return [product, digest];
  }));
}

function usable(snapshot: ScanSnapshot): boolean {
  return snapshot.chain.network === 'test' && snapshot.health === 'ready' && snapshot.caughtUp && snapshot.complete;
}

/** Everything that must hold before a run may init the recorder or pay. */
export async function preflightChecks(): Promise<string[]> {
  const blockers: string[] = [];
  const check = async (label: string, fn: () => Promise<boolean>): Promise<void> => {
    try {
      if (!(await fn())) blockers.push(label);
    } catch {
      blockers.push(label);
    }
  };
  await check('public store does not list both books available on testnet', async () => {
    const products = await (await fetch(`${PUBLIC_ORIGIN}/api/products`)).json() as Array<{ version: string; available: boolean; network: string; amountZat: string }>;
    return PRODUCTS.every((version) => products.some((p) => p.version === version && p.available && p.network === 'test' && p.amountZat === AMOUNT_ZAT));
  });
  await check('embed origin is unreachable', async () => (await fetch(`${EMBED_ORIGIN}/`)).status === 200);
  let seller: ScanSnapshot | null = null;
  // A new block can briefly put a scanner behind tip; poll before calling it a blocker.
  const settled = async (fn: () => Promise<boolean>): Promise<boolean> => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (await fn().catch(() => false)) return true;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    return false;
  };
  await check('seller scanner is not ready and caught up on testnet', () => settled(async () => { seller = await sellerSnapshot(); return usable(seller); }));
  await check('independent checker is not ready and caught up on testnet', () => settled(async () => {
    const checker = await checkerSnapshot();
    return usable(checker) && (seller === null || checker.chain.genesisHash === (seller as ScanSnapshot).chain.genesisHash);
  }));
  await check('VPS seller, scanner or logos-a is unhealthy', () => pi.healthy());
  await check('deployed VPS build/log evidence is missing or inconsistent', async () => {
    const capture = collectPublicCapture();
    return capture.sellerFacts.ready.scanner && capture.sellerFacts.ready.messaging && capture.sellerFacts.ready.checkout;
  });
  await check('fixture plaintext digests are missing', async () => Object.keys(fixtures()).length === PRODUCTS.length);
  const state = loadState();
  await check('buyer wallet cannot fund the remaining purchases', async () => {
    const status = await walletStatus();
    if (!status || status.pending > 0) return false;
    const done = [state?.a?.send === 'sent', state?.b?.send === 'sent'].filter(Boolean).length;
    const needed = MAX_SENDS - done;
    if (status.remaining < needed) return false;
    return status.spendableZat >= BigInt(needed) * (BigInt(AMOUNT_ZAT) + FEE_RESERVE_ZAT);
  });
  if (!state) {
    await check('browser profile directory already used by an earlier run', async () =>
      !['a', 'a-import', 'b', 'origin'].some((label) => existsSync(path.join(PROFILES, label))));
  }
  return blockers;
}

function liveDeps(driver: BrowserDriver): T01Deps {
  return {
    products: [...PRODUCTS],
    expectedPlaintextSha256: fixtures(),
    amountZat: AMOUNT_ZAT,
    pollMs: 2_000,
    timeoutMs: 45 * 60_000,
    freshProfile: (label) => path.join(PROFILES, label),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadState,
    saveState: (state) => writePrivateJson(STATE_FILE, state),
    preflight: preflightChecks,
    recorder: {
      async init() {
        if ((await observe(['--profile', 'public', 'init'])) !== 0) throw new Error('live-observe init failed');
      },
      async stage(id, status, evidence) {
        const args = ['--profile', 'public', 'stage', id, '--status', status];
        for (const line of evidence) args.push('--evidence', line);
        if ((await observe(args)) !== 0) throw new Error(`live-observe stage ${id} failed`);
      },
    },
    browser: driver,
    wallet: { send: walletSend },
    sellerSnapshot,
    checkerSnapshot: () => checkerSnapshot(),
    pi,
    log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
  };
}

/** No-payment browser rehearsal: invoice, relaunch recovery, backup export/import, QR check. */
async function dryRun(): Promise<number> {
  const driver = createPlaywrightDriver();
  const root = path.join(PROFILES, 'dry-run', String(Date.now()));
  try {
    const profile = path.join(root, 'buyer');
    const invoice = await driver.openInvoice(profile, PRODUCTS[0]);
    const lines = [`invoice persisted; qr equals uri: ${invoice.qr === invoice.uri}`];
    await driver.relaunch(profile);
    const reopened = await driver.purchase(profile, invoice.requestId);
    lines.push(`same order after relaunch: ${reopened?.orderId === invoice.orderId && reopened?.uri === invoice.uri}`);
    const backup = await driver.exportBackup(profile, invoice.requestId);
    const imported = path.join(root, 'import');
    await driver.importBackup(imported, backup);
    const restored = await driver.purchase(imported, invoice.requestId);
    lines.push(`same order after backup import: ${restored?.orderId === invoice.orderId && restored?.uri === invoice.uri}`);
    lines.push(`payment state (unpaid expected): ${await driver.paymentState(profile, invoice.requestId)}`);
    process.stdout.write(`${lines.join('\n')}\nno wallet command was invoked; no recorder init\n`);
    return lines.every((line) => !line.endsWith('false')) ? 0 : 1;
  } finally {
    await driver.closeAll();
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (rest.length > 0) throw new Error('usage: public-t01-live.ts preflight|dry-run|run|status|finalize|verify-report');
  if (command === 'preflight') {
    const blockers = await preflightChecks();
    for (const blocker of blockers) process.stdout.write(`BLOCKED: ${blocker}\n`);
    if (blockers.length === 0) process.stdout.write('preflight ok\n');
    return blockers.length === 0 ? 0 : 2;
  }
  if (command === 'dry-run') return dryRun();
  if (command === 'status') {
    const state = loadState();
    process.stdout.write(`${JSON.stringify(state ? {
      initDone: state.initDone, done: state.done, stages: state.stages,
      a: state.a ? { product: state.a.product, send: state.a.send } : null,
      b: state.b ? { product: state.b.product, send: state.b.send } : null,
    } : { state: 'none' })}\n`);
    return 0;
  }
  if (command === 'run') {
    const driver = createPlaywrightDriver();
    try {
      return await runT01(liveDeps(driver));
    } finally {
      await driver.closeAll();
    }
  }
  if (command === 'finalize') {
    return finalizeT01({ loadState, sellerSnapshot, amountZat: AMOUNT_ZAT, log: (line) => process.stdout.write(`${line}\n`) }, observe);
  }
  if (command === 'verify-report') {
    if (!existsSync(REPORT)) {
      process.stdout.write('no report\n');
      return 1;
    }
    const validation = validateLiveReport(JSON.parse(readFileSync(REPORT, 'utf8')));
    for (const error of validation.errors) process.stdout.write(`${error}\n`);
    process.stdout.write(validation.ok ? 'report valid\n' : 'report invalid\n');
    return validation.ok ? 0 : 1;
  }
  throw new Error('usage: public-t01-live.ts preflight|dry-run|run|status|finalize|verify-report');
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
