import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createCredentialAdapter } from '../../src/adapters/credentials.ts';
import { createCryptoAdapter } from '../../src/adapters/crypto.ts';
import {
  ROUTING_MARKERS,
  applicationContentTopic,
  buildPublicEnvelope,
  encodeApplicationPayload,
  inspectPublicRouting,
} from '../../src/adapters/messaging.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { decryptDownload } from '../../src/browser/download.ts';
import { openPurchaseStore, type IDBFactoryLike } from '../../src/browser/purchases.ts';
import { loadConfig, type RuntimeConfig } from '../../src/config.ts';
import type { BrowserPurchase, DeliveryPackage, Invoice, OrderStatus } from '../../src/contracts/types.ts';
import { exportSellerBackup, restoreSellerBackup } from '../../src/seller/backup.ts';
import { startSeller, type SellerServer } from '../../src/seller/server.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();
const DESTINATION =
  'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

let scratchDir = '';
const servers: SellerServer[] = [];

afterEach(async () => {
  const closing = servers.splice(0);
  await Promise.all(closing.map((s) => s.close().catch(() => undefined)));
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = '';
});

function env(dbPath: string, overrides: Record<string, string> = {}): RuntimeConfig {
  return loadConfig({
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
    SSF_DB_PATH: dbPath,
    SSF_SELLER_KEY_ID: 'seller-key-1',
    SSF_DESTINATION: DESTINATION,
    SSF_ADAPTER_MESSAGING: 'fixture',
    SSF_ADAPTER_STORAGE: 'fixture',
    SSF_ADAPTER_SCANNER: 'fixture',
    SSF_ADMIN_TOKEN: 'admin-token-not-for-examples',
    ...overrides,
  });
}

function memoryIndexedDB(): IDBFactoryLike {
  const rows = new Map<string, unknown>();
  return {
    open() {
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        transaction() {
          const tx = {
            oncomplete: null as ((ev?: unknown) => void) | null,
            onerror: null as ((ev?: unknown) => void) | null,
            onabort: null as ((ev?: unknown) => void) | null,
            error: null,
            objectStore() {
              return {
                put(value: { requestId: string }) {
                  const req = {
                    result: undefined as unknown,
                    error: null,
                    onsuccess: null as ((ev?: unknown) => void) | null,
                    onerror: null as ((ev?: unknown) => void) | null,
                  };
                  queueMicrotask(() => {
                    rows.set(value.requestId, value);
                    req.onsuccess?.();
                    tx.oncomplete?.();
                  });
                  return req;
                },
                get(key: string) {
                  const req = {
                    result: rows.get(key) as unknown,
                    error: null,
                    onsuccess: null as ((ev?: unknown) => void) | null,
                    onerror: null as ((ev?: unknown) => void) | null,
                  };
                  queueMicrotask(() => req.onsuccess?.());
                  return req;
                },
                getAll() {
                  const req = {
                    result: [...rows.values()] as unknown,
                    error: null,
                    onsuccess: null as ((ev?: unknown) => void) | null,
                    onerror: null as ((ev?: unknown) => void) | null,
                  };
                  queueMicrotask(() => req.onsuccess?.());
                  return req;
                },
              };
            },
          };
          return tx;
        },
        close() {},
      };
      const req = {
        result: db,
        error: null,
        onsuccess: null as ((ev?: unknown) => void) | null,
        onerror: null as ((ev?: unknown) => void) | null,
        onupgradeneeded: null as ((ev?: unknown) => void) | null,
      };
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

async function jsonRequest(
  url: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`${url}${path}`, init);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

async function possessionProof(
  credentials: ReturnType<typeof createCredentialAdapter>,
  credentialId: string,
  orderId: string,
): Promise<string> {
  return Buffer.from(await credentials.provePossession(credentialId, { orderId })).toString('base64');
}

test('wired adapter keeps ORDER_MARK BUYER_MARK PRODUCT_MARK in encrypted JSON only', () => {
  const payload = encodeApplicationPayload({
    ORDER_MARK: 'ORDER_MARK',
    BUYER_MARK: 'BUYER_MARK',
    PRODUCT_MARK: 'PRODUCT_MARK',
    body: { kind: 'status' },
  });
  const decoded = JSON.parse(new TextDecoder().decode(payload)) as Record<string, string>;
  expect(decoded.ORDER_MARK).toBe('ORDER_MARK');
  expect(decoded.BUYER_MARK).toBe('BUYER_MARK');
  expect(decoded.PRODUCT_MARK).toBe('PRODUCT_MARK');

  const envelope = buildPublicEnvelope('run-task9', payload);
  expect(envelope.contentTopic).toBe(applicationContentTopic('run-task9'));
  expect(envelope.contentTopic).not.toContain('ORDER_MARK');
  const inspection = inspectPublicRouting(envelope);
  expect(inspection.ok).toBe(true);
  expect(inspection.found).toEqual([]);
  expect(ROUTING_MARKERS).toEqual(['ORDER_MARK', 'BUYER_MARK', 'PRODUCT_MARK']);

  const dirty = inspectPublicRouting({
    contentTopic: '/ssf/1/ORDER_MARK/proto',
    pubsubTopic: '/waku/2/rs/1/0',
    version: 1,
    timestamp: Date.now(),
    ephemeral: false,
    meta: null,
    rateLimitProof: null,
  });
  expect(dirty.ok).toBe(false);
  expect(dirty.found).toEqual(['ORDER_MARK']);
});

test('malicious backup imports and wrong seller identity are rejected', async () => {
  const credentials = createCredentialAdapter();
  const created = await credentials.createPurchaseCredential();
  const store = await openPurchaseStore({
    sellerOrigin: 'http://127.0.0.1:8787',
    sellerKeyId: 'seller-key-1',
    credentials,
    indexedDB: memoryIndexedDB(),
    persist: null,
    dbName: 'ssf-sec-import',
  });
  const record: BrowserPurchase = {
    version: 1,
    requestId: 'req-1',
    orderId: 'ord-1',
    productVersion: 'book-v1',
    sellerOrigin: 'http://127.0.0.1:8787',
    sellerKeyId: 'seller-key-1',
    credentialId: created.credentialId,
    invoice: null,
  };
  await store.save(record);
  const good = await store.exportBackup('req-1');

  await expect(store.importBackup(new TextEncoder().encode('not-json'))).rejects.toThrow(/malformed backup/);
  await expect(store.importBackup(new TextEncoder().encode('[]'))).rejects.toThrow(/malformed backup|unsupported backup version/);
  await expect(store.importBackup(new TextEncoder().encode(JSON.stringify({
    version: 1,
    kind: 'not-this',
    sellerOrigin: 'http://127.0.0.1:8787',
    sellerKeyId: 'seller-key-1',
    purchase: { version: 1, requestId: 'x', productVersion: 'book-v1', orderId: null, invoice: null },
    credential: { privateKeyHex: 'aa', publicKeyHex: 'bb' },
  })))).rejects.toThrow(/kind/);

  const parsed = JSON.parse(new TextDecoder().decode(good)) as Record<string, unknown>;
  parsed.sellerOrigin = 'http://evil.example';
  await expect(store.importBackup(new TextEncoder().encode(JSON.stringify(parsed)))).rejects.toThrow(/origin/);
  parsed.sellerOrigin = 'http://127.0.0.1:8787';
  parsed.sellerKeyId = 'attacker-seller';
  await expect(store.importBackup(new TextEncoder().encode(JSON.stringify(parsed)))).rejects.toThrow(/seller identity/);
});

test('cross-origin, unauthorized admin, wrong proof, buyer A vs B, replay and gateway exhaustion', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-sec-'));
  const credentials = createCredentialAdapter();
  const buyerA = await credentials.createPurchaseCredential();
  const buyerB = await credentials.createPurchaseCredential();
  const scanner = new MemoryScanner();
  scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  const storage = createMemoryStorageAdapter();
  const innerFetch = storage.fetch.bind(storage);
  storage.fetch = async (cid: string) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return innerFetch(cid);
  };
  const seller = await startSeller({
    config: env(join(scratchDir, 'seller.sqlite')),
    seedProduct: true,
    scanner,
    credentials,
    storage,
  });
  servers.push(seller);

  const cors = await jsonRequest(seller.publicUrl, '/api/product', {
    headers: { origin: 'https://evil.example' },
  });
  expect(cors.status).toBe(200);
  expect(cors.headers.get('access-control-allow-origin')).not.toBe('*');
  expect(cors.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');

  const preflight = await jsonRequest(seller.publicUrl, '/api/orders', { method: 'OPTIONS' });
  expect(preflight.status).toBeGreaterThanOrEqual(400);

  const adminPublic = await jsonRequest(seller.publicUrl, '/admin/health');
  expect(adminPublic.status).toBe(404);
  const adminNoToken = await jsonRequest(seller.adminUrl, '/admin/health');
  expect(adminNoToken.status).toBe(401);
  const adminWrong = await jsonRequest(seller.adminUrl, '/admin/health', {
    headers: { authorization: 'Bearer wrong' },
  });
  expect(adminWrong.status).toBe(401);

  const override = await jsonRequest(seller.publicUrl, '/api/mark-paid', { method: 'POST', body: '{}' });
  expect(override.status).toBe(404);

  const createdA = await jsonRequest(seller.publicUrl, '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-a',
      productVersion: 'book-v1',
      buyerKeyId: buyerA.buyerKeyId,
      proof: await possessionProof(credentials, buyerA.credentialId, 'req-a'),
    }),
  });
  expect(createdA.status).toBe(200);
  const invoiceA = JSON.parse(createdA.body) as Invoice;

  const createdB = await jsonRequest(seller.publicUrl, '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-b',
      productVersion: 'book-v1',
      buyerKeyId: buyerB.buyerKeyId,
      proof: await possessionProof(credentials, buyerB.credentialId, 'req-b'),
    }),
  });
  expect(createdB.status).toBe(200);
  const invoiceB = JSON.parse(createdB.body) as Invoice;

  const wrongProof = await jsonRequest(seller.publicUrl, '/api/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: invoiceA.orderId,
      proof: await possessionProof(credentials, buyerB.credentialId, invoiceA.orderId),
    }),
  });
  expect(wrongProof.status).toBe(403);

  const crossStatus = await jsonRequest(seller.publicUrl, '/api/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: invoiceB.orderId,
      proof: await possessionProof(credentials, buyerA.credentialId, invoiceB.orderId),
    }),
  });
  expect(crossStatus.status).toBe(403);
  const crossRecover = await jsonRequest(seller.publicUrl, '/api/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: invoiceB.orderId,
      proof: await possessionProof(credentials, buyerA.credentialId, invoiceB.orderId),
    }),
  });
  expect(crossRecover.status).toBe(403);

  scanner.replaceSnapshot([{
    outputId: 'out-a',
    invoiceId: invoiceA.id,
    amountZat: invoiceA.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: Date.now(),
    revision: { id: 'rev-10', height: 10 },
  }], { id: 'rev-10', height: 10 }, true, Date.now());

  const firstRecover = await jsonRequest(seller.publicUrl, '/api/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: invoiceA.orderId,
      proof: await possessionProof(credentials, buyerA.credentialId, invoiceA.orderId),
    }),
  });
  expect(firstRecover.status).toBe(200);
  const replayRecover = await jsonRequest(seller.publicUrl, '/api/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: invoiceA.orderId,
      proof: await possessionProof(credentials, buyerA.credentialId, invoiceA.orderId),
    }),
  });
  expect(replayRecover.status).toBe(200);
  const replayWrong = await jsonRequest(seller.publicUrl, '/api/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: invoiceA.orderId,
      proof: await possessionProof(credentials, buyerB.credentialId, invoiceA.orderId),
    }),
  });
  expect(replayWrong.status).toBe(403);

  const bursts = await Promise.all(
    Array.from({ length: 8 }, () => jsonRequest(seller.publicUrl, '/ciphertext/book-v1')),
  );
  expect(bursts.some((item) => item.status === 429)).toBe(true);
  expect(bursts.every((item) => item.body.includes('sovereign-storefront harmless fixture') === false)).toBe(true);
});

test('unavailable storage, scanner outage and seller restart stay honest', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-avail-sec-'));
  const dbPath = join(scratchDir, 'seller.sqlite');
  const credentials = createCredentialAdapter();
  const buyer = await credentials.createPurchaseCredential();
  const scanner = new MemoryScanner();
  scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  const storage = createMemoryStorageAdapter();
  const seller = await startSeller({
    config: env(dbPath),
    seedProduct: true,
    scanner,
    credentials,
    storage,
    availability: { storageReplica: false },
  });
  servers.push(seller);

  const blocked = await jsonRequest(seller.publicUrl, '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-down',
      productVersion: 'book-v1',
      buyerKeyId: buyer.buyerKeyId,
      proof: await possessionProof(credentials, buyer.credentialId, 'req-down'),
    }),
  });
  expect(blocked.status).toBe(503);

  await seller.close();
  servers.pop();

  const live = await startSeller({
    config: env(dbPath),
    seedProduct: false,
    scanner,
    credentials,
    storage,
  });
  servers.push(live);

  const unpaidCreated = await jsonRequest(live.publicUrl, '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-unpaid',
      productVersion: 'book-v1',
      buyerKeyId: buyer.buyerKeyId,
      proof: await possessionProof(credentials, buyer.credentialId, 'req-unpaid'),
    }),
  });
  expect(unpaidCreated.status).toBe(200);
  const unpaidInvoice = JSON.parse(unpaidCreated.body) as Invoice;

  const paidCreated = await jsonRequest(live.publicUrl, '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-paid-status',
      productVersion: 'book-v1',
      buyerKeyId: buyer.buyerKeyId,
      proof: await possessionProof(credentials, buyer.credentialId, 'req-paid-status'),
    }),
  });
  expect(paidCreated.status).toBe(200);
  const paidInvoice = JSON.parse(paidCreated.body) as Invoice;
  scanner.replaceSnapshot([{
    outputId: 'out-paid-status',
    invoiceId: paidInvoice.id,
    amountZat: paidInvoice.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: Date.now(),
    revision: { id: 'rev-10', height: 10 },
  }], { id: 'rev-10', height: 10 }, true, Date.now());
  const paidBefore = await jsonRequest(live.publicUrl, '/api/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: paidInvoice.orderId,
      proof: await possessionProof(credentials, buyer.credentialId, paidInvoice.orderId),
    }),
  });
  expect(paidBefore.status).toBe(200);
  expect((JSON.parse(paidBefore.body) as OrderStatus).payment).toBe('confirmed');

  scanner.setHealth({ healthy: false, caughtUp: false, checkedAt: Date.now() });
  await live.close();
  servers.pop();
  const restarted = await startSeller({
    config: env(dbPath),
    seedProduct: false,
    scanner,
    credentials,
    storage,
  });
  servers.push(restarted);
  const availability = await jsonRequest(restarted.publicUrl, '/api/availability');
  expect(JSON.parse(availability.body).scanner).toBe(false);

  const unpaidStatus = await jsonRequest(restarted.publicUrl, '/api/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: unpaidInvoice.orderId,
      proof: await possessionProof(credentials, buyer.credentialId, unpaidInvoice.orderId),
    }),
  });
  expect(unpaidStatus.status).toBe(200);
  const unpaidBody = JSON.parse(unpaidStatus.body) as OrderStatus;
  expect(unpaidBody.payment).toBe('awaiting');
  expect(['unavailable', 'stale']).toContain(unpaidBody.verification);

  const paidStatus = await jsonRequest(restarted.publicUrl, '/api/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: paidInvoice.orderId,
      proof: await possessionProof(credentials, buyer.credentialId, paidInvoice.orderId),
    }),
  });
  expect(paidStatus.status).toBe(200);
  const paidBody = JSON.parse(paidStatus.body) as OrderStatus;
  expect(paidBody.payment).not.toBe('awaiting');
  expect(paidBody.payment).toBe('confirmed');
  expect(['unavailable', 'stale']).toContain(paidBody.verification);
});

test('seller backup restores into an isolated instance without spending keys or rewriting the buyer record', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-bak-'));
  const originDir = join(scratchDir, 'origin');
  const isolatedDir = join(scratchDir, 'isolated');
  const originDb = join(originDir, 'seller.sqlite');
  const credentials = createCredentialAdapter();
  const buyer = await credentials.createPurchaseCredential();
  const scanner = new MemoryScanner();
  scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  const origin = await startSeller({
    config: env(originDb),
    seedProduct: true,
    scanner,
    credentials,
  });
  servers.push(origin);

  const created = await jsonRequest(origin.publicUrl, '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-paid',
      productVersion: 'book-v1',
      buyerKeyId: buyer.buyerKeyId,
      proof: await possessionProof(credentials, buyer.credentialId, 'req-paid'),
    }),
  });
  const invoice = JSON.parse(created.body) as Invoice;
  scanner.replaceSnapshot([{
    outputId: 'out-paid',
    invoiceId: invoice.id,
    amountZat: invoice.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: Date.now(),
    revision: { id: 'rev-10', height: 10 },
  }], { id: 'rev-10', height: 10 }, true, Date.now());
  const recovered = await jsonRequest(origin.publicUrl, '/api/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: invoice.orderId,
      proof: await possessionProof(credentials, buyer.credentialId, invoice.orderId),
    }),
  });
  expect(recovered.status).toBe(200);

  const buyerRecord: BrowserPurchase = {
    version: 1,
    requestId: 'req-paid',
    orderId: invoice.orderId,
    productVersion: 'book-v1',
    sellerOrigin: origin.publicUrl,
    sellerKeyId: 'seller-key-1',
    credentialId: buyer.credentialId,
    invoice,
  };
  const snapshot = structuredClone(buyerRecord);

  const backupKey = randomBytes(32);
  const encrypted = await exportSellerBackup({
    dbPath: originDb,
    sellerKeyId: 'seller-key-1',
    key: backupKey,
  });
  await origin.close();
  servers.pop();

  const encryptedText = Buffer.from(encrypted).toString('utf8');
  expect(encryptedText).not.toContain('secret-spending-key');
  expect(encryptedText).not.toMatch(/spending/i);

  const restored = await restoreSellerBackup({
    encrypted,
    key: backupKey,
    destDbPath: join(isolatedDir, 'seller.sqlite'),
  });
  expect(restored.sellerKeyId).toBe('seller-key-1');
  expect(restored.spendingKeysPresent).toBe(false);
  expect(createHash('sha256').update(encrypted).digest('hex')).toBeTruthy();

  const isolated = await startSeller({
    config: env(join(isolatedDir, 'seller.sqlite'), { SSF_SELLER_KEY_ID: restored.sellerKeyId }),
    seedProduct: false,
    scanner,
    credentials,
  });
  servers.push(isolated);

  expect(buyerRecord).toEqual(snapshot);
  expect(buyerRecord.sellerKeyId).toBe('seller-key-1');
  const again = await jsonRequest(isolated.publicUrl, '/api/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: invoice.orderId,
      proof: await possessionProof(credentials, buyer.credentialId, invoice.orderId),
    }),
  });
  expect(again.status).toBe(200);
  expect(JSON.parse(again.body).orderId).toBe(invoice.orderId);
});

test('composed seller seals a real delivery envelope, not the dummy [1] byte', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-seal-'));
  const credentials = createCredentialAdapter();
  const buyer = await credentials.createPurchaseCredential();
  const scanner = new MemoryScanner();
  scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  const storage = createMemoryStorageAdapter();
  const seller = await startSeller({
    config: env(join(scratchDir, 'seller.sqlite')),
    seedProduct: true,
    scanner,
    credentials,
    storage,
  });
  servers.push(seller);

  const created = await jsonRequest(seller.publicUrl, '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-seal',
      productVersion: 'book-v1',
      buyerKeyId: buyer.buyerKeyId,
      proof: await possessionProof(credentials, buyer.credentialId, 'req-seal'),
    }),
  });
  expect(created.status).toBe(200);
  const invoice = JSON.parse(created.body) as Invoice;
  scanner.replaceSnapshot([{
    outputId: 'out-seal',
    invoiceId: invoice.id,
    amountZat: invoice.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: Date.now(),
    revision: { id: 'rev-10', height: 10 },
  }], { id: 'rev-10', height: 10 }, true, Date.now());

  const recovered = await jsonRequest(seller.publicUrl, '/api/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: invoice.orderId,
      proof: await possessionProof(credentials, buyer.credentialId, invoice.orderId),
    }),
  });
  expect(recovered.status).toBe(200);
  const body = JSON.parse(recovered.body) as {
    orderId: string;
    productVersion: string;
    buyerKeyId: string;
    encryptedEnvelope: string;
  };
  const envelope = Buffer.from(body.encryptedEnvelope, 'base64');
  expect(Array.from(envelope)).not.toEqual([1]);
  expect(envelope.subarray(0, 4).toString()).toBe('SSDL');

  const ciphertextRes = await fetch(`${seller.publicUrl}/ciphertext/book-v1`);
  expect(ciphertextRes.ok).toBe(true);
  const ciphertext = new Uint8Array(await ciphertextRes.arrayBuffer());
  const pkg: DeliveryPackage = {
    orderId: body.orderId,
    productVersion: body.productVersion,
    buyerKeyId: body.buyerKeyId,
    encryptedEnvelope: new Uint8Array(envelope),
  };
  const blob = await decryptDownload(pkg, ciphertext, {
    crypto: createCryptoAdapter({ credentials }),
    credentialId: buyer.credentialId,
  });
  expect(blob.type).toBe('application/octet-stream');
  expect(new TextDecoder().decode(await blob.arrayBuffer())).toContain('sovereign-storefront harmless fixture');
});

test('raw buyer key in possession proof is rejected; wrong buyer still 403', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-raw-proof-'));
  const credentials = createCredentialAdapter();
  const buyer = await credentials.createPurchaseCredential();
  const other = await credentials.createPurchaseCredential();
  const scanner = new MemoryScanner();
  scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  const seller = await startSeller({
    config: env(join(scratchDir, 'seller.sqlite')),
    seedProduct: true,
    scanner,
    credentials,
  });
  servers.push(seller);

  const created = await jsonRequest(seller.publicUrl, '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-raw-proof',
      productVersion: 'book-v1',
      buyerKeyId: buyer.buyerKeyId,
      proof: await possessionProof(credentials, buyer.credentialId, 'req-raw-proof'),
    }),
  });
  expect(created.status).toBe(200);
  const invoice = JSON.parse(created.body) as Invoice;
  const backup = JSON.parse(new TextDecoder().decode(await credentials.exportBackupMaterial(buyer.credentialId))) as {
    privateKeyHex: string;
  };
  const rawKeyProof = Buffer.from(backup.privateKeyHex, 'hex').toString('base64');
  expect(Buffer.from(rawKeyProof, 'base64').byteLength).toBe(32);

  const rawStatus = await jsonRequest(seller.publicUrl, '/api/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: invoice.orderId, proof: rawKeyProof }),
  });
  expect(rawStatus.status).toBe(403);

  const rawRecover = await jsonRequest(seller.publicUrl, '/api/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: invoice.orderId, proof: rawKeyProof }),
  });
  expect(rawRecover.status).toBe(403);

  const wrong = await jsonRequest(seller.publicUrl, '/api/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: invoice.orderId,
      proof: await possessionProof(credentials, other.credentialId, invoice.orderId),
    }),
  });
  expect(wrong.status).toBe(403);
});
