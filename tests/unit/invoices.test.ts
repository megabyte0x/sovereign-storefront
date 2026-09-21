import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openStore } from '../../src/seller/db.ts';
import type { Observation } from '../../src/contracts/types.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();

let dbPath = '';
let scratchDir = '';
let store: Awaited<ReturnType<typeof openStore>>;

beforeEach(() => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-invoices-'));
  dbPath = join(scratchDir, 'seller.sqlite');
});

afterEach(async () => {
  await store?.close().catch(() => undefined);
  rmSync(scratchDir, { recursive: true, force: true });
});

test('getOrCreateInvoice persists immutable terms and rejects incompatible or blocked issuance', async () => {
  store = await openStore(dbPath);
  const availability = {productPublished: true, messaging: true, storageReplica: true, scanner: true};
  const order = await store.createOrder({requestId: 'retry-1', buyerKeyId: 'buyer-a', productVersion: 'book-v1'});
  const first = await store.getOrCreateInvoice({
    orderId: order.id, buyerKeyId: 'buyer-a', productVersion: 'book-v1', now: 1000, availability,
  });
  await store.close();
  store = await openStore(dbPath);
  const again = await store.getOrCreateInvoice({
    orderId: order.id, buyerKeyId: 'buyer-a', productVersion: 'book-v1', now: 1500, availability,
  });
  expect(again).toEqual(first);
  expect(again.amountZat).toBe(first.amountZat);
  expect(again.destination).toBe(first.destination);
  expect(again.attributionRef).toBe(first.attributionRef);
  expect(again.productVersion).toBe('book-v1');
  expect(again.expiresAt).toBe(first.expiresAt);
  await expect(store.getOrCreateInvoice({
    orderId: order.id, buyerKeyId: 'buyer-b', productVersion: 'book-v1', now: 1600, availability,
  })).rejects.toThrow();
  const stillIssued = await store.getOrCreateInvoice({
    orderId: order.id, buyerKeyId: 'buyer-a', productVersion: 'book-v1', now: 1700,
    availability: {...availability, scanner: false},
  });
  expect(stillIssued.id).toBe(first.id);
  const blocked = await store.createOrder({requestId: 'new-2', buyerKeyId: 'buyer-a', productVersion: 'book-v1'});
  await expect(store.getOrCreateInvoice({
    orderId: blocked.id, buyerKeyId: 'buyer-a', productVersion: 'book-v1', now: 1800,
    availability: {...availability, scanner: false},
  })).rejects.toThrow();
});

test('commitReconciliation is atomic and unique output claims cannot move invoices', async () => {
  store = await openStore(dbPath);
  const availability = {productPublished: true, messaging: true, storageReplica: true, scanner: true};
  const orderA = await store.createOrder({requestId: 'a', buyerKeyId: 'buyer-a', productVersion: 'book-v1'});
  const orderB = await store.createOrder({requestId: 'b', buyerKeyId: 'buyer-b', productVersion: 'book-v1'});
  const invoiceA = await store.getOrCreateInvoice({
    orderId: orderA.id, buyerKeyId: 'buyer-a', productVersion: 'book-v1', now: 1000, availability,
  });
  const invoiceB = await store.getOrCreateInvoice({
    orderId: orderB.id, buyerKeyId: 'buyer-b', productVersion: 'book-v1', now: 1000, availability,
  });
  const revision = { id: 'rev-1', height: 10 };
  const observation: Observation = {
    outputId: 'out-1',
    invoiceId: invoiceA.id,
    amountZat: invoiceA.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: 1000,
    revision,
  };
  await store.commitReconciliation({
    checkpoint: { revision },
    observations: [observation],
    settlements: [{
      payment: 'confirmed',
      releaseEligible: true,
      backingOutputIds: ['out-1'],
      exceptions: [],
    }],
  });
  await store.close();
  store = await openStore(dbPath);
  expect(await store.getCheckpoint()).toEqual({ revision });

  await expect(store.commitReconciliation({
    checkpoint: { revision: { id: 'rev-2', height: 11 } },
    observations: [{ ...observation, invoiceId: invoiceB.id, revision: { id: 'rev-2', height: 11 } }],
    settlements: [],
  })).rejects.toThrow();
  expect(await store.getCheckpoint()).toEqual({ revision });
});

test('crash after observations and before commit leaves the previous checkpoint unchanged', async () => {
  let crashAfterObservations = false;
  store = await openStore(dbPath, {
    crashAfterObservations: () => {
      if (crashAfterObservations) {
        throw new Error('injected crash after observations');
      }
    },
  });
  const firstRevision = { id: 'rev-1', height: 10 };
  await store.commitReconciliation({
    checkpoint: { revision: firstRevision },
    observations: [],
    settlements: [],
  });
  crashAfterObservations = true;
  await expect(store.commitReconciliation({
    checkpoint: { revision: { id: 'rev-2', height: 11 } },
    observations: [{
      outputId: 'out-crash',
      invoiceId: null,
      amountZat: '100000000',
      confirmations: 1,
      canonical: true,
      receivedAt: 1000,
      revision: { id: 'rev-2', height: 11 },
    }],
    settlements: [],
  })).rejects.toThrow(/injected crash/);
  crashAfterObservations = false;
  await store.close();
  store = await openStore(dbPath);
  expect(await store.getCheckpoint()).toEqual({ revision: firstRevision });
});

test('compareAndSetDelivery is atomic and prepared packages are unique per order', async () => {
  store = await openStore(dbPath);
  const order = await store.createOrder({requestId: 'pkg-1', buyerKeyId: 'buyer-a', productVersion: 'book-v1'});
  expect(await store.getDelivery(order.id)).toBe('locked');
  const revision = { id: 'rev-1', height: 1 };
  expect(await store.compareAndSetDelivery(order.id, 'locked', 'prepared', revision)).toBe(true);
  expect(await store.compareAndSetDelivery(order.id, 'locked', 'queued', revision)).toBe(false);
  expect(await store.getDelivery(order.id)).toBe('prepared');
  const pkg = {
    orderId: order.id,
    productVersion: 'book-v1',
    buyerKeyId: 'buyer-a',
    encryptedEnvelope: new Uint8Array([1, 2, 3]),
  };
  await store.savePreparedPackage(pkg);
  await expect(store.savePreparedPackage(pkg)).rejects.toThrow();
  await store.close();
  store = await openStore(dbPath);
  expect(await store.getDelivery(order.id)).toBe('prepared');
  expect(await store.getPreparedPackage(order.id)).toEqual(pkg);
});
