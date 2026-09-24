import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { fixtureAllocation, fixtureSnapshot } from '../support/live-fixtures.ts';
import { openStore } from '../../src/seller/db.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();
let scratchDir = '';
let store: Awaited<ReturnType<typeof openStore>> | undefined;

afterEach(async () => {
  await store?.close().catch(() => undefined);
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

test('commits a later generation even when its canonical height rewinds', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-live-migrations-'));
  store = await openStore(join(scratchDir, 'seller.sqlite'));
  const old = fixtureSnapshot({ generation: '7' });
  const rewind = fixtureSnapshot({
    generation: '8',
    tip: { height: 15, hash: 'b'.repeat(64) },
    scanned: { height: 15, hash: 'b'.repeat(64) },
  });

  await store.commitSnapshot({ snapshot: old, observations: [], settlements: [] });
  await expect(store.commitSnapshot({
    snapshot: fixtureSnapshot({ generation: '8', chain: { ...old.chain, network: 'test' } }),
    observations: [], settlements: [],
  })).rejects.toThrow(/chain\/account changed/);
  await store.commitSnapshot({ snapshot: rewind, observations: [], settlements: [] });

  expect((await store.getScanSnapshot())?.generation).toBe('8');
  expect((await store.getReconciledCheckpoint())?.generation).toBe('8');
});

test('rolls back snapshot observations and checkpoint after per-store fault injection', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-live-migrations-'));
  const path = join(scratchDir, 'seller.sqlite');
  let fail = false;
  store = await openStore(path, {
    crashAfterObservations: () => {
      if (fail) throw new Error('injected snapshot failure');
    },
  });
  const initial = fixtureSnapshot({ generation: '1' });
  await store.commitSnapshot({ snapshot: initial, observations: [], settlements: [] });
  fail = true;

  await expect(store.commitSnapshot({
    snapshot: fixtureSnapshot({ generation: '2' }),
    observations: [],
    settlements: [],
  })).rejects.toThrow('injected snapshot failure');
  await store.close();
  store = await openStore(path);

  expect((await store.getScanSnapshot())?.generation).toBe('1');
  expect((await store.getReconciledCheckpoint())?.generation).toBe('1');
});

test('newer snapshot generations authoritatively replace, reorg, and remove receipt projections', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-live-migrations-'));
  const path = join(scratchDir, 'seller.sqlite');
  store = await openStore(path);
  const first = fixtureSnapshot({ generation: '1' });
  await store.commitSnapshot({ snapshot: first, observations: [], settlements: [] });

  const replaced = fixtureSnapshot({
    generation: '2', tip: { height: 15, hash: 'b'.repeat(64) }, scanned: { height: 15, hash: 'b'.repeat(64) },
    receipts: [{
      ...first.receipts[0], outputId: 'output-2', txid: 'f'.repeat(64), outputIndex: 2,
      mined: { height: 15, hash: 'b'.repeat(64) }, firstSeenAt: 1_000_001,
    }],
  });
  await store.commitSnapshot({ snapshot: replaced, observations: [], settlements: [] });
  expect(await store.listObservations()).toEqual([expect.objectContaining({
    outputId: 'output-2', sourceId: replaced.sourceId, generation: '2', canonical: true,
    chainNetwork: 'regtest', txid: 'f'.repeat(64), pool: 'orchard', outputIndex: 2,
  })]);

  const reorged = fixtureSnapshot({
    generation: '3', tip: replaced.tip, scanned: replaced.scanned,
    receipts: [{ ...replaced.receipts[0], canonical: false, mined: null }],
  });
  await store.commitSnapshot({ snapshot: reorged, observations: [], settlements: [] });
  expect((await store.listObservations())[0]).toMatchObject({ outputId: 'output-2', canonical: false, generation: '3' });

  const omitted = fixtureSnapshot({ generation: '4', tip: reorged.tip, scanned: reorged.scanned, receipts: [] });
  await store.commitSnapshot({ snapshot: omitted, observations: [], settlements: [] });
  await store.close();
  store = await openStore(path);
  expect(await store.listObservations()).toEqual([]);
  expect((await store.getScanSnapshot())?.generation).toBe('4');
});

test('migrates a known-network v1 invoice as immutable legacy-memo data', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-live-migrations-'));
  const path = join(scratchDir, 'seller.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE orders (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, buyer_key_id TEXT NOT NULL, product_version TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE invoices (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, product_version TEXT NOT NULL, buyer_key_id TEXT NOT NULL, network TEXT NOT NULL, amount_zat TEXT NOT NULL, destination TEXT NOT NULL, attribution_ref TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO store_settings VALUES ('network', 'test');
    INSERT INTO orders VALUES ('order-v1', 'request-v1', 'buyer-v1', 'product-v1', 1);
    INSERT INTO invoices VALUES ('invoice-v1', 'order-v1', 'product-v1', 'buyer-v1', 'test', '100000000', 'legacy-destination', 'memo-v1', 2, 1);
  `);
  legacy.close();

  store = await openStore(path);
  const invoice = await store.getInvoice('order-v1');
  expect(invoice?.attribution).toEqual({ kind: 'legacy-memo', reference: 'memo-v1' });
  expect(invoice?.attributionRef).toBe('memo-v1');
});

test('refuses an ambiguous v1 invoice network rather than inferring live terms', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-live-migrations-'));
  const path = join(scratchDir, 'seller.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE orders (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, buyer_key_id TEXT NOT NULL, product_version TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE invoices (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, product_version TEXT NOT NULL, buyer_key_id TEXT NOT NULL, network TEXT NOT NULL, amount_zat TEXT NOT NULL, destination TEXT NOT NULL, attribution_ref TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO orders VALUES ('order-v1', 'request-v1', 'buyer-v1', 'product-v1', 1);
    INSERT INTO invoices VALUES ('invoice-v1', 'order-v1', 'product-v1', 'buyer-v1', 'test', '100000000', 'legacy-destination', 'memo-v1', 2, 1);
  `);
  legacy.close();

  await expect(openStore(path)).rejects.toThrow(/ambiguous v1 invoice network/);
});

test('fresh stores migrate final invoice columns before reserve and commit', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-live-migrations-'));
  const path = join(scratchDir, 'seller.sqlite');
  const catalogue = openCatalogue({ dbPath: path, storage: createMemoryStorageAdapter() });
  catalogue.beginPublication({ version: 'product-v1', description: 'fixture', amountZat: '100000000', network: 'regtest' });
  catalogue.completePublication({
    version: 'product-v1', ciphertextCid: 'fixture-cid', ciphertextDigest: 'a'.repeat(64), fileSize: 1,
    sellerKeyRef: 'fixture-key', wrappedKey: new Uint8Array([1]),
  });
  catalogue.close();
  store = await openStore(path);
  const order = await store.createOrder({ requestId: 'request-fresh', buyerKeyId: 'buyer-fresh', productVersion: 'product-v1' });
  const draft = await store.reserveInvoice({
    orderId: order.id, buyerKeyId: 'buyer-fresh', productVersion: 'product-v1', now: 1_000_000, ttlMs: 60_000,
    chain: fixtureSnapshot().chain, accountId: fixtureSnapshot().accountId,
  });

  await expect(store.commitInvoice(draft.id, fixtureAllocation({
    allocationId: draft.id, amountZat: draft.amountZat, expiresAt: draft.expiresAt,
  }))).resolves.toMatchObject({
    attribution: { kind: 'receiver', allocationId: draft.id },
  });
});

test('binds package acknowledgement to the persisted immutable package identity', async () => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-live-migrations-'));
  store = await openStore(join(scratchDir, 'seller.sqlite'));
  const order = await store.createOrder({ requestId: 'request-package', buyerKeyId: 'buyer-package', productVersion: 'product-v1' });
  await store.savePreparedPackage({
    orderId: order.id, productVersion: 'product-v1', buyerKeyId: 'buyer-package', encryptedEnvelope: new Uint8Array([1, 2, 3]),
  });
  const pkg = await store.getPreparedPackage(order.id);
  expect(pkg?.packageId).toMatch(/^[0-9a-f]{64}$/);
  await expect(store.acknowledgePackage(order.id, 'wrong-package')).rejects.toThrow(/package/);
  await expect(store.acknowledgePackage(order.id, pkg!.packageId!)).resolves.toBeUndefined();
  await expect(store.acknowledgePackage(order.id, pkg!.packageId!)).resolves.toBeUndefined();
});
