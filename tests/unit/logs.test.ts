import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { createCredentialAdapter } from '../../src/adapters/credentials.ts';
import { createMemoryMessaging } from '../../src/adapters/messaging.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { encodeZip321 } from '../../src/browser/app.ts';
import { loadConfig } from '../../src/config.ts';
import {
  ALLOWED_LOG_FIELDS,
  createOperationalLogger,
  type OperationalLogger,
} from '../../src/ops/log.ts';
import { startSeller, type SellerServer } from '../../src/seller/server.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratchRoot = process.env.TMPDIR ?? tmpdir();

const INV_MARK = 'INV_MARK_9f3c2a1b_SYNTHETIC_INVOICE';
const MEMO_MARK = 'MEMO_MARK_7e4d8c0a_SYNTHETIC_ATTR';
const URI_MARK = 'URI_MARK_1b2c3d4e_SYNTHETIC_ZIP321';
const SENTINEL_PRIVKEY = 'SENTINEL_PRIVKEY_000000000000deadbeef';
const SPENDING_KEY_MARK = 'secret-spending-key-must-never-log';

const DESTINATION =
  'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

const MARKERS = [INV_MARK, MEMO_MARK, URI_MARK, SENTINEL_PRIVKEY, SPENDING_KEY_MARK];

let scratchDir = '';
let seller: SellerServer | undefined;
const captured: string[] = [];

afterEach(async () => {
  await seller?.close().catch(() => undefined);
  seller = undefined;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = '';
  captured.length = 0;
});

function sinkLogger(): OperationalLogger {
  return createOperationalLogger((line) => captured.push(line));
}

function haystack(): string {
  return captured.join('\n');
}

function assertNoMarkers(text: string, label: string): void {
  for (const marker of MARKERS) {
    expect(text.includes(marker), `${label} leaked ${marker}`).toBe(false);
  }
}

test('allowlisted schema rejects whole-record invoice logging on success and error', () => {
  const log = sinkLogger();
  const invoice = {
    id: INV_MARK,
    orderId: 'ord-1',
    productVersion: 'book-v1',
    buyerKeyId: 'buyer-1',
    network: 'test' as const,
    amountZat: '100000000',
    destination: DESTINATION,
    attributionRef: MEMO_MARK,
    expiresAt: Date.now() + 86_400_000,
  };
  const uri = `${encodeZip321(invoice)}&message=${URI_MARK}`;

  log.log({
    event: 'invoice.issued',
    invoice,
    attributionRef: MEMO_MARK,
    paymentUri: uri,
    privateKeyHex: SENTINEL_PRIVKEY,
    spendingKey: SPENDING_KEY_MARK,
  });
  log.log({
    event: 'error',
    code: 'invoice_failed',
    invoice,
    memo: MEMO_MARK,
    uri,
    privateKey: SENTINEL_PRIVKEY,
  });

  const text = haystack();
  expect(text.length).toBeGreaterThan(0);
  assertNoMarkers(text, 'logger sink');
  expect(text).not.toMatch(/"invoice"\s*:/);
  for (const line of captured) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      expect(ALLOWED_LOG_FIELDS.has(key), `unexpected field ${key}`).toBe(true);
    }
  }
});

test('sentinel private keys are required absences and not the only forbidden values', () => {
  const log = sinkLogger();
  log.log({
    event: 'http.response',
    path: '/api/orders',
    status: 200,
    privateKeyHex: SENTINEL_PRIVKEY,
    invoiceId: INV_MARK,
    attributionRef: MEMO_MARK,
    paymentUri: URI_MARK,
  });
  const text = haystack();
  expect(text.includes(SENTINEL_PRIVKEY)).toBe(false);
  expect(text.includes(INV_MARK)).toBe(false);
  expect(text.includes(MEMO_MARK)).toBe(false);
  expect(text.includes(URI_MARK)).toBe(false);
});

test('service, adapter, scanner and HTTP paths drop synthetic invoice, memo and URI markers', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-logs-'));
  const log = sinkLogger();
  const credentials = createCredentialAdapter();
  const buyer = await credentials.createPurchaseCredential();
  const proof = Buffer.from(await credentials.provePossession(buyer.credentialId)).toString('base64');
  const scanner = new MemoryScanner();
  scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  const config = loadConfig({
    SSF_MODE: 'fixture',
    SSF_NETWORK: 'test',
    SSF_MIN_CONFIRMATIONS: '10',
    SSF_MAX_HEALTH_AGE_MS: '120000',
    SSF_MAX_CIPHERTEXT_BYTES: '73',
    SSF_MAX_PLAINTEXT_BYTES: '41',
    SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_HOST: '127.0.0.1',
    SSF_PUBLIC_PORT: '0',
    SSF_ADMIN_HOST: '127.0.0.1',
    SSF_ADMIN_PORT: '0',
    SSF_DB_PATH: join(scratchDir, 'seller.sqlite'),
    SSF_SELLER_KEY_ID: 'seller-key-1',
    SSF_DESTINATION: DESTINATION,
    SSF_ADAPTER_MESSAGING: 'fixture',
    SSF_ADAPTER_STORAGE: 'fixture',
    SSF_ADAPTER_SCANNER: 'fixture',
    SSF_ADMIN_TOKEN: 'admin-token-not-a-credential-example',
  });
  seller = await startSeller({
    config,
    seedProduct: true,
    scanner,
    credentials,
    messaging: createMemoryMessaging(),
    logger: log,
  });

  const created = await fetch(`${seller.publicUrl}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-logs-1',
      productVersion: 'book-v1',
      buyerKeyId: buyer.buyerKeyId,
      proof,
    }),
  });
  expect(created.status).toBe(200);
  const invoice = await created.json() as {
    id: string;
    orderId: string;
    attributionRef: string;
    destination: string;
    amountZat: string;
  };
  const uri = encodeZip321({
    id: INV_MARK,
    orderId: invoice.orderId,
    productVersion: 'book-v1',
    buyerKeyId: buyer.buyerKeyId,
    network: 'test',
    amountZat: invoice.amountZat,
    destination: invoice.destination,
    attributionRef: MEMO_MARK,
    expiresAt: Date.now() + 1000,
  });
  log.log({
    event: 'payment.observed',
    invoice: { ...invoice, id: INV_MARK, attributionRef: MEMO_MARK },
    paymentUri: `${uri}&x=${URI_MARK}`,
    privateKeyHex: SENTINEL_PRIVKEY,
  });

  const badStatus = await fetch(`${seller.publicUrl}/api/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: invoice.orderId, proof: Buffer.from('nope').toString('base64') }),
  });
  expect(badStatus.status).toBe(403);

  const adminDenied = await fetch(`${seller.adminUrl}/admin/health`);
  expect(adminDenied.status).toBe(401);

  scanner.replaceSnapshot([{
    outputId: 'out-logs',
    invoiceId: invoice.id,
    amountZat: invoice.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: Date.now(),
    revision: { id: 'rev-10', height: 10 },
  }], { id: 'rev-10', height: 10 }, true, Date.now());

  const okStatus = await fetch(`${seller.publicUrl}/api/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: invoice.orderId, proof }),
  });
  expect(okStatus.status).toBe(200);

  assertNoMarkers(haystack(), 'service/adapter/http logs');
  expect(haystack()).not.toContain(invoice.attributionRef);
  expect(haystack()).not.toContain(invoice.destination);
  expect(haystack()).not.toContain(invoice.id);
  const events = captured.map((line) => (JSON.parse(line) as { event: string }).event);
  expect(events).toContain('http.request');
  expect(events).toContain('http.response');
  expect(events).toContain('admin.auth');
});

test('saved probe evidence does not place routing markers in public fields or log private keys', () => {
  const messaging = JSON.parse(readFileSync(join(ROOT, 'spikes/results/messaging.json'), 'utf8')) as {
    routingMarkers: { placement: string; foundInPublicFields: string[]; markers: string[] };
  };
  expect(messaging.routingMarkers.placement).toMatch(/encrypted application JSON only/i);
  expect(messaging.routingMarkers.foundInPublicFields).toEqual([]);
  expect(messaging.routingMarkers.markers).toEqual(['ORDER_MARK', 'BUYER_MARK', 'PRODUCT_MARK']);

  const evidence = [
    readFileSync(join(ROOT, 'spikes/results/messaging.json'), 'utf8'),
    readFileSync(join(ROOT, 'spikes/results/storage.json'), 'utf8'),
    readFileSync(join(ROOT, 'spikes/results/payments.json'), 'utf8'),
  ].join('\n');
  expect(evidence).not.toContain(SENTINEL_PRIVKEY);
  expect(evidence).not.toMatch(/"privateKeyHex"\s*:\s*"[0-9a-f]{32,}/i);
  expect(evidence).not.toContain(INV_MARK);
  expect(evidence).not.toContain(MEMO_MARK);
  expect(evidence).not.toContain(URI_MARK);
});
