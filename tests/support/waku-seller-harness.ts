/**
 * "Waku live, payment fixture" seller harness for Playwright.
 *
 * Starts an in-process real-demo-shaped seller:
 *  - config: `loadConfig` in `SSF_MODE=real-demo`, `SSF_NETWORK=regtest`, the
 *    real-demo caps (120000/73/41, 10 confirmations), 0600 token/scanner files;
 *  - Waku: a REAL `createWakuSession` over the live public bootstrap peers
 *    pinned in `.runtime/live/live.env` (`WAKU_BOOTSTRAP_PEERS`), on a fresh
 *    per-run content topic derived from `SSF_WAKU_CONTENT_TOPIC` (same
 *    application/version, so the same autoshard);
 *  - payment: `MemoryScanner`, a LABELLED FIXTURE. The payment is not what the
 *    Waku acceptance spec proves; `pay()` feeds a 10-confirmation receipt.
 *  - storage: the in-memory storage adapter, also a labelled fixture.
 *
 * The browser is served the built `dist/browser` by the seller itself, so the
 * real-demo CSP (connect-src = configured peers) is enforced by Chromium.
 *
 * Nothing secret is logged. `live.env` values are read in-process and never
 * printed; only key presence is reported in a skip reason.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hexToBytes } from '@waku/utils/bytes';
import { createWakuFulfillmentMessaging } from '../../src/adapters/live.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { createWakuSession } from '../../src/adapters/waku.ts';
import { loadConfig, type RuntimeConfig } from '../../src/config.ts';
import type { WakuSession } from '../../src/contracts/messages.ts';
import { loadOrCreateSellerIdentity } from '../../src/seller/identity.ts';
import { attachSellerApplication, createSellerApplication } from '../../src/seller/messages.ts';
import { startSeller, type SellerServer } from '../../src/seller/server.ts';

/** The plaintext the seeded fixture product decrypts to. */
export const FIXTURE_PLAINTEXT = 'sovereign-storefront harmless fixture v1\n';
export const HARNESS_LABEL = 'Waku live, payment fixture';

const ACTIVATIONS = {
  overwinter: 1, sapling: 1, blossom: 1, heartwood: 1, canopy: 1, nu5: 1, nu6: 1,
  'nu6-1': null, 'nu6-2': null, 'nu6-3': null,
};
const FIXTURE_ACCOUNT = 'fixture-account-r35';
const START_TIP = 10;

export type WakuSellerHarness = {
  url: string;
  bootstrapPeers: string[];
  contentTopic: string;
  sellerKeyId: string;
  /** Labelled fixture payment: a canonical receipt with exactly 10 confirmations. */
  pay(): Promise<void>;
  /** Seller-side delivery state for the only order. */
  deliveryState(): Promise<string | null>;
  /** Invoices the seller issued (each one proves a create request arrived over Waku). */
  invoiceCount(): Promise<number>;
  close(): Promise<void>;
};

export type HarnessResult = { ok: true; harness: WakuSellerHarness } | { ok: false; reason: string };

export const STRICT_LIVE = process.env.SSF_STRICT_LIVE === '1';

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]!] = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Reads only the two public Waku keys the harness needs. */
export function readLiveWaku(root: string): { peers: string; topic: string } | { reason: string } {
  const path = join(root, '.runtime', 'live', 'live.env');
  if (!existsSync(path)) return { reason: `live precondition missing: ${path} not found (run infra:up)` };
  const env = parseEnvFile(path);
  const peers = env.WAKU_BOOTSTRAP_PEERS ?? '';
  const topic = env.SSF_WAKU_CONTENT_TOPIC ?? '';
  if (!peers || !topic) return { reason: 'live precondition missing: WAKU_BOOTSTRAP_PEERS/SSF_WAKU_CONTENT_TOPIC absent from live.env' };
  return { peers, topic };
}

/** Same application/version (same autoshard), fresh name so old traffic cannot interfere. */
function freshTopic(base: string): string {
  const parts = base.split('/');
  if (parts.length !== 5) return base;
  parts[3] = `${parts[3]}-r35-${randomBytes(6).toString('hex')}`;
  return parts.join('/');
}

function writeProtected(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

export async function startWakuSellerHarness(root: string): Promise<HarnessResult> {
  const live = readLiveWaku(root);
  if ('reason' in live) return { ok: false, reason: live.reason };
  const publicDir = join(root, 'dist', 'browser');
  if (!existsSync(join(publicDir, 'index.html'))) {
    return { ok: false, reason: 'dist/browser/index.html missing: run npm run build first' };
  }

  const scratch = mkdtempSync(join(tmpdir(), 'ssf-r35-'));
  let session: WakuSession | undefined;
  let seller: SellerServer | undefined;
  let detach: (() => Promise<void>) | undefined;
  const cleanup = async (): Promise<void> => {
    await detach?.().catch(() => undefined);
    await seller?.close().catch(() => undefined);
    await session?.close().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  };

  try {
    const scannerConfig = join(scratch, 'scanner.json');
    writeProtected(scannerConfig, JSON.stringify({
      ufvk: 'fixture-not-a-real-ufvk',
      runtime: { chain: { network: 'regtest', genesisHash: 'ab'.repeat(32) }, activations: ACTIVATIONS, sourceId: 'fixture-scanner' },
    }));
    const tokenFile = join(scratch, 'admin.token');
    writeProtected(tokenFile, `${randomBytes(24).toString('hex')}\n`);
    mkdirSync(join(scratch, 'data'), { recursive: true });
    const contentTopic = freshTopic(live.topic);
    const config: RuntimeConfig = loadConfig({
      SSF_MODE: 'real-demo',
      SSF_NETWORK: 'regtest',
      SSF_MIN_CONFIRMATIONS: '10',
      SSF_MAX_HEALTH_AGE_MS: '120000',
      SSF_MAX_CIPHERTEXT_BYTES: '73',
      SSF_MAX_PLAINTEXT_BYTES: '41',
      SSF_INVOICE_TTL_MS: '86400000',
      SSF_PUBLIC_HOST: '127.0.0.1',
      SSF_PUBLIC_PORT: '0',
      SSF_ADMIN_HOST: '127.0.0.1',
      SSF_ADMIN_PORT: '0',
      SSF_DB_PATH: join(scratch, 'data', 'seller.sqlite'),
      SSF_ADMIN_TOKEN_FILE: tokenFile,
      SSF_ADAPTER_MESSAGING: 'real',
      SSF_ADAPTER_STORAGE: 'real',
      SSF_ADAPTER_SCANNER: 'real',
      // The payment is a fixture: this socket path is never opened.
      SSF_SCANNER_SOCKET: join(scratch, 'unused.sock'),
      SSF_SCANNER_ACCOUNT_ID: FIXTURE_ACCOUNT,
      SSF_SCANNER_CONFIG: scannerConfig,
      SSF_WAKU_CONTENT_TOPIC: contentTopic,
      WAKU_BOOTSTRAP_PEERS: live.peers,
      SSF_WAKU_PEER_TIMEOUT_MS: '30000',
      LOGOSCTL: join(scratch, 'unused-logosctl'),
      LOGOS_NODE_A: join(scratch, 'unused-node-a'),
      LOGOS_NODE_B: join(scratch, 'unused-node-b'),
    });
    const liveCfg = config.live!;
    const identity = loadOrCreateSellerIdentity(config.dbPath);

    // REAL Waku over the live bootstrap peers.
    session = createWakuSession(liveCfg.waku, hexToBytes(identity.privateKeyHex));
    let ready = false;
    try {
      ready = await withTimeout(session.ready(), 45_000, 'waku ready timed out');
    } catch (error) {
      await cleanup();
      return { ok: false, reason: `live Waku peers unreachable: ${error instanceof Error ? error.message : 'error'}` };
    }
    if (!ready) {
      await cleanup();
      return { ok: false, reason: 'live Waku peers unreachable: session not ready (no filter subscription/connection)' };
    }

    // LABELLED FIXTURE: payment only.
    const scanner = new MemoryScanner();
    scanner.replaceReceiptSourceSnapshot({
      version: 1,
      sourceId: 'fixture-scanner',
      generation: '1',
      chain: { ...liveCfg.chain },
      accountId: FIXTURE_ACCOUNT,
      tip: { height: START_TIP, hash: 'd'.repeat(64) },
      scanned: { height: START_TIP, hash: 'd'.repeat(64) },
      checkedAt: Date.now(),
      caughtUp: true,
      complete: true,
      health: 'ready',
      receipts: [],
    });
    scanner.replaceSnapshot([], { id: 'rev-start', height: START_TIP }, true, Date.now());

    const wakuSession = session;
    seller = await startSeller({
      config,
      sellerKeyId: identity.publicKeyHex,
      seedProduct: true,
      scanner,
      storage: createMemoryStorageAdapter(),
      messaging: createWakuFulfillmentMessaging(wakuSession, identity.publicKeyHex, config.productNetwork),
      publicDir,
      replicaReady: () => true,
      probes: {
        messaging: async () => wakuSession.ready().catch(() => false),
        scanner: async () => (await scanner.snapshot()).health === 'ready',
      },
      beforeListen: async (core) => {
        const application = createSellerApplication({
          store: core.store,
          issuer: core.issuer,
          payments: core.payments,
          sellerKeyId: identity.publicKeyHex,
          network: config.productNetwork,
          now: Date.now,
        });
        detach = await attachSellerApplication(wakuSession, application, {
          sellerKeyId: identity.publicKeyHex,
          network: config.productNetwork,
        });
      },
    });
    const server = seller;

    return {
      ok: true,
      harness: {
        url: server.publicUrl,
        bootstrapPeers: [...liveCfg.waku.bootstrapPeers],
        contentTopic,
        sellerKeyId: identity.publicKeyHex,
        async pay() {
          const invoices = await server.core.store.listInvoices();
          const invoice = invoices[invoices.length - 1];
          if (!invoice?.attribution || invoice.attribution.kind !== 'receiver') {
            throw new Error('fixture pay: no receiver-attributed invoice issued yet');
          }
          const outputId = `fixture-output-${invoice.orderId}`;
          scanner.setReceiptReceiver(outputId, invoice.attribution.receiver);
          // Receipt at START_TIP+1, tip at START_TIP+10 → exactly 10 confirmations.
          scanner.replaceSnapshot([{
            outputId,
            invoiceId: null,
            amountZat: invoice.amountZat,
            confirmations: 10,
            canonical: true,
            receivedAt: Date.now(),
            revision: { id: 'rev-paid', height: START_TIP + 1 },
          }], { id: 'rev-tip', height: START_TIP + 10 }, true, Date.now());
        },
        async deliveryState() {
          const invoices = await server.core.store.listInvoices();
          const invoice = invoices[invoices.length - 1];
          return invoice ? server.core.store.getDelivery(invoice.orderId) : null;
        },
        async invoiceCount() {
          return (await server.core.store.listInvoices()).length;
        },
        close: cleanup,
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
