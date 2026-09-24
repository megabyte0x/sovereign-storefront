import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openStore } from '../../src/seller/db.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { createInvoiceIssuer } from '../../src/seller/issuance.ts';
import type { ServiceAvailability } from '../../src/contracts/types.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();
let scratchDir = '';
let store: Awaited<ReturnType<typeof openStore>> | undefined;

// Match MemoryScanner's own fixture defaults (src/adapters/scanner.ts) rather
// than the unrelated live-fixtures chain, since MemoryScanner enforces its
// own chain/account identity on every allocateReceiver call.
const chain = { network: 'regtest' as const, genesisHash: 'a'.repeat(64), consensusFingerprint: 'c'.repeat(64) };
const accountId = 'fixture-account';
const AVAILABLE: ServiceAvailability = { productPublished: true, messaging: true, storageReplica: true, scanner: true };

afterEach(async () => {
  await store?.close().catch(() => undefined);
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

function setupProduct(dbPath: string, amountZat = '100000000'): void {
  const catalogue = openCatalogue({ dbPath, storage: createMemoryStorageAdapter() });
  catalogue.beginPublication({ version: 'product-v1', description: 'fixture', amountZat, network: chain.network });
  catalogue.completePublication({
    version: 'product-v1', ciphertextCid: 'fixture-cid', ciphertextDigest: 'a'.repeat(64), fileSize: 1,
    sellerKeyRef: 'fixture-key', wrappedKey: new Uint8Array([1]),
  });
  catalogue.close();
}

test('issues a durable receiver invoice and replays identical terms on retry after restart', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-issuance-'));
  const dbPath = join(scratchDir, 'seller.sqlite');
  setupProduct(dbPath);
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId, ttlMs: 60_000, now: () => 1_000_000,
    availability: async () => AVAILABLE,
  });
  const request = { requestId: 'request-1', buyerKeyId: 'buyer-1', productVersion: 'product-v1', expectedAmountZat: '100000000' };

  const first = await issuer.issue(request);
  expect(first.attribution?.kind).toBe('receiver');
  expect(first.paymentUri ?? '').not.toContain('memo=');
  expect((first.paymentUri ?? '').startsWith('zcash:')).toBe(true);

  const replay = await issuer.issue(request);
  expect(replay).toEqual(first);

  await store.close();
  store = await openStore(dbPath);
  const restartedIssuer = createInvoiceIssuer({
    store, scanner, chain, accountId, ttlMs: 60_000, now: () => 1_000_000,
    availability: async () => AVAILABLE,
  });
  const restartedReplay = await restartedIssuer.issue(request);
  expect(restartedReplay).toEqual(first);

  await expect(restartedIssuer.issue({ ...request, expectedAmountZat: '1' })).rejects.toThrow('request terms changed');
});

test('new request IDs receive distinct receivers even for the same buyer/product', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-issuance-'));
  const dbPath = join(scratchDir, 'seller.sqlite');
  setupProduct(dbPath);
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId, ttlMs: 60_000, now: () => 1_000_000,
    availability: async () => AVAILABLE,
  });
  const first = await issuer.issue({ requestId: 'request-a', buyerKeyId: 'buyer-1', productVersion: 'product-v1', expectedAmountZat: '100000000' });
  const second = await issuer.issue({ requestId: 'request-b', buyerKeyId: 'buyer-1', productVersion: 'product-v1', expectedAmountZat: '100000000' });
  expect(second.destination).not.toBe(first.destination);
  if (first.attribution?.kind !== 'receiver' || second.attribution?.kind !== 'receiver') throw new Error('receiver fixture required');
  expect(second.attribution.receiver.receiverHex).not.toBe(first.attribution.receiver.receiverHex);
});

test('concurrent identical requests converge on one durable invoice', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-issuance-'));
  const dbPath = join(scratchDir, 'seller.sqlite');
  setupProduct(dbPath);
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId, ttlMs: 60_000, now: () => 1_000_000,
    availability: async () => AVAILABLE,
  });
  const request = { requestId: 'request-concurrent', buyerKeyId: 'buyer-1', productVersion: 'product-v1', expectedAmountZat: '100000000' };
  const [a, b] = await Promise.all([issuer.issue(request), issuer.issue(request)]);
  expect(a).toEqual(b);
});

test('a crash after scanner allocation but before invoice commit is safely retried to the same invoice', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-issuance-'));
  const dbPath = join(scratchDir, 'seller.sqlite');
  setupProduct(dbPath);
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const request = { requestId: 'request-crash', buyerKeyId: 'buyer-1', productVersion: 'product-v1', expectedAmountZat: '100000000' };

  const order = await store.createOrder({ requestId: request.requestId, buyerKeyId: request.buyerKeyId, productVersion: request.productVersion });
  const draft = await store.reserveInvoice({
    orderId: order.id, buyerKeyId: request.buyerKeyId, productVersion: request.productVersion,
    chain, accountId, now: 1_000_000, ttlMs: 60_000,
  });
  // Scanner-side allocation is durable ("crash" happens before commitInvoice runs).
  await scanner.allocateReceiver({ allocationId: draft.id, chain: draft.chain, accountId: draft.accountId, amountZat: draft.amountZat, expiresAt: draft.expiresAt });

  const crashedIssuer = createInvoiceIssuer({
    store, scanner, chain, accountId, ttlMs: 60_000, now: () => 1_000_000,
    availability: async () => AVAILABLE,
  });
  const retried = await crashedIssuer.issue(request);
  expect(retried.attribution?.kind).toBe('receiver');
  expect(retried.amountZat).toBe('100000000');
});

test('rejects checkout for a product that does not exist rather than defaulting amount', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-issuance-'));
  const dbPath = join(scratchDir, 'seller.sqlite');
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId, ttlMs: 60_000, now: () => 1_000_000,
    availability: async () => AVAILABLE,
  });
  await expect(issuer.issue({ requestId: 'request-missing', buyerKeyId: 'buyer-1', productVersion: 'missing-product', expectedAmountZat: '100000000' }))
    .rejects.toThrow();
});

test('rejects new issuance when a required dependency is unavailable, but replays an already-issued invoice', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-issuance-'));
  const dbPath = join(scratchDir, 'seller.sqlite');
  setupProduct(dbPath);
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  let available = true;
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId, ttlMs: 60_000, now: () => 1_000_000,
    availability: async () => ({ ...AVAILABLE, messaging: available }),
  });
  const request = { requestId: 'request-outage', buyerKeyId: 'buyer-1', productVersion: 'product-v1', expectedAmountZat: '100000000' };
  const first = await issuer.issue(request);

  available = false;
  await expect(issuer.issue({ requestId: 'request-new', buyerKeyId: 'buyer-1', productVersion: 'product-v1', expectedAmountZat: '100000000' }))
    .rejects.toThrow('checkout unavailable');
  await expect(issuer.issue(request)).resolves.toEqual(first);
});

test('mixed-network catalogue rejects a product published on a different network than the configured chain', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-issuance-'));
  const dbPath = join(scratchDir, 'seller.sqlite');
  const catalogue = openCatalogue({ dbPath, storage: createMemoryStorageAdapter() });
  catalogue.beginPublication({ version: 'wrong-network', description: 'fixture', amountZat: '100000000', network: 'test' });
  catalogue.completePublication({
    version: 'wrong-network', ciphertextCid: 'fixture-cid', ciphertextDigest: 'a'.repeat(64), fileSize: 1,
    sellerKeyRef: 'fixture-key', wrappedKey: new Uint8Array([1]),
  });
  catalogue.close();
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId, ttlMs: 60_000, now: () => 1_000_000,
    availability: async () => AVAILABLE,
  });
  await expect(issuer.issue({ requestId: 'request-mixed', buyerKeyId: 'buyer-1', productVersion: 'wrong-network', expectedAmountZat: '100000000' }))
    .rejects.toThrow();
});
