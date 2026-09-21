import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryScanner, SCANNER_MAPPING } from '../../src/adapters/scanner.ts';
import { DEFAULT_POLICY, createPayments } from '../../src/seller/payments.ts';
import { openStore } from '../../src/seller/db.ts';
import type { Invoice, Observation, SellerStore } from '../../src/contracts/types.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();
const availability = {productPublished: true, messaging: true, storageReplica: true, scanner: true};

let dbPath = '';
let scratchDir = '';
let store: SellerStore;

beforeEach(() => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-payments-'));
  dbPath = join(scratchDir, 'seller.sqlite');
});

afterEach(async () => {
  await store?.close().catch(() => undefined);
  rmSync(scratchDir, { recursive: true, force: true });
});

async function seed(storeRef: SellerStore, buyerKeyId = 'buyer-a') {
  const order = await storeRef.createOrder({requestId: `req-${buyerKeyId}`, buyerKeyId, productVersion: 'book-v1'});
  const invoice = await storeRef.getOrCreateInvoice({
    orderId: order.id, buyerKeyId, productVersion: 'book-v1', now: 1000, availability,
  });
  return { order, invoice };
}

function observation(invoice: Invoice, overrides: Partial<Observation> = {}): Observation {
  return {
    outputId: 'out-a',
    invoiceId: invoice.id,
    amountZat: invoice.amountZat,
    confirmations: DEFAULT_POLICY.minConfirmations,
    canonical: true,
    receivedAt: 1000,
    revision: { id: 'rev-10', height: 10 },
    ...overrides,
  };
}

function envelope(invoice: Invoice) {
  return {
    orderId: invoice.orderId,
    productVersion: invoice.productVersion,
    buyerKeyId: invoice.buyerKeyId,
    encryptedEnvelope: new Uint8Array([7, 7, 7]),
  };
}

test('scanner mapping is a labelled dashboard double, not compact-block WalletRead', () => {
  expect(SCANNER_MAPPING.walletReadWired).toBe(false);
  expect(SCANNER_MAPPING.compactBlockScan).toBe(false);
  expect(SCANNER_MAPPING.liveAttribution).toBe('destination-ua');
  expect(SCANNER_MAPPING.reducerAttribution).toContain('invoiceId');
  expect(SCANNER_MAPPING.minConfirmationsDefault).toBe(10);
  expect(DEFAULT_POLICY.minConfirmations).toBe(10);
});

test('commitReconciliation advances the checkpoint only after observations and settlements commit', async () => {
  store = await openStore(dbPath);
  const { invoice } = await seed(store);
  const scanner = new MemoryScanner();
  const receipt = observation(invoice);
  scanner.replaceSnapshot([receipt], receipt.revision, true, 1000);
  const payments = createPayments({
    store,
    scanner,
    now: () => 1000,
    preparePackage: async (inv) => envelope(inv),
  });
  payments.cacheInvoice(invoice);
  expect(await store.getCheckpoint()).toBeNull();
  await payments.reconcileObservation(receipt);
  expect(await store.getCheckpoint()).toEqual({ revision: receipt.revision });
  expect(await store.getDelivery(invoice.orderId)).toBe('prepared');
  expect(await store.getPreparedPackage(invoice.orderId)).toEqual(envelope(invoice));
  const decision = await payments.authorizeRelease(invoice.orderId);
  expect(decision.disclose).toBe(true);
  expect(decision.reason).toBe('first_release');
});

test('crash after observation and before commit recovers the output through observations(from) without double-claim', async () => {
  let crash = false;
  store = await openStore(dbPath, {
    crashAfterObservations: () => {
      if (crash) throw new Error('injected crash after observations');
    },
  });
  const { invoice } = await seed(store);
  const scanner = new MemoryScanner();
  const receipt = observation(invoice);
  scanner.replaceSnapshot([receipt], receipt.revision, true, 1000);
  const payments = createPayments({
    store,
    scanner,
    now: () => 1000,
    preparePackage: async (inv) => envelope(inv),
  });
  payments.cacheInvoice(invoice);
  crash = true;
  await expect(payments.reconcileObservation(receipt)).rejects.toThrow(/injected crash/);
  crash = false;
  expect(await store.getCheckpoint()).toBeNull();
  await store.close();

  store = await openStore(dbPath);
  const restarted = createPayments({
    store,
    scanner,
    now: () => 1000,
    preparePackage: async (inv) => envelope(inv),
  });
  restarted.cacheInvoice(invoice);
  await restarted.reconcileFromScanner();
  expect(await store.getCheckpoint()).toEqual({ revision: receipt.revision });
  await restarted.reconcileFromScanner();
  expect(await store.getCheckpoint()).toEqual({ revision: receipt.revision });
  const status = await restarted.orderStatus(invoice.orderId);
  expect(status.payment).toBe('confirmed');
  expect(status.exceptions.filter((item) => item.code === 'duplicate')).toHaveLength(0);
});

test('prepared package existence is not disclosure', async () => {
  store = await openStore(dbPath);
  const { invoice } = await seed(store);
  const scanner = new MemoryScanner();
  const receipt = observation(invoice);
  scanner.replaceSnapshot([receipt], receipt.revision, true, 1000);
  const payments = createPayments({
    store,
    scanner,
    now: () => 1000,
    preparePackage: async (inv) => envelope(inv),
  });
  payments.cacheInvoice(invoice);
  await payments.reconcileObservation(receipt);
  expect(await store.getPreparedPackage(invoice.orderId)).not.toBeNull();
  expect(await store.getDelivery(invoice.orderId)).toBe('prepared');
  scanner.setHealth({ healthy: false, caughtUp: false, revision: receipt.revision, checkedAt: 1000 });
  const decision = await payments.authorizeRelease(invoice.orderId);
  expect(decision.disclose).toBe(false);
  expect(decision.reason).toBe('not_eligible');
  expect(decision.package).toBeNull();
});

test('scanner outage sets verification unavailable or stale and does not mark a confirmed purchase unpaid', async () => {
  store = await openStore(dbPath);
  const { invoice } = await seed(store);
  const scanner = new MemoryScanner();
  const receipt = observation(invoice);
  scanner.replaceSnapshot([receipt], receipt.revision, true, 1000);
  const payments = createPayments({
    store,
    scanner,
    now: () => 1000,
    preparePackage: async (inv) => envelope(inv),
  });
  payments.cacheInvoice(invoice);
  await payments.reconcileObservation(receipt);
  expect((await payments.orderStatus(invoice.orderId)).payment).toBe('confirmed');

  scanner.setHealth({ healthy: false, caughtUp: false, revision: receipt.revision, checkedAt: 1000 });
  await payments.reconcileObservation({ ...receipt, confirmations: 11, revision: { id: 'rev-11', height: 11 } });
  const down = await payments.orderStatus(invoice.orderId);
  expect(down.payment).toBe('confirmed');
  expect(down.verification).toBe('unavailable');
  expect(down.exceptions.some((item) => item.code === 'verification_unavailable')).toBe(true);
  expect((await payments.authorizeRelease(invoice.orderId)).disclose).toBe(false);

  scanner.setHealth({
    healthy: true,
    caughtUp: true,
    revision: { id: 'rev-11', height: 11 },
    checkedAt: 1000 - DEFAULT_POLICY.maxHealthAgeMs - 1,
  });
  const stale = await payments.orderStatus(invoice.orderId);
  expect(stale.payment).toBe('confirmed');
  expect(stale.verification).toBe('stale');
});

test('exceptions are independent of payment and delivery enums', async () => {
  store = await openStore(dbPath);
  const { invoice } = await seed(store);
  const scanner = new MemoryScanner();
  const over: Observation = observation(invoice, { amountZat: `${BigInt(invoice.amountZat) + 1n}` });
  scanner.replaceSnapshot([over], over.revision, true, 1000);
  const payments = createPayments({
    store,
    scanner,
    now: () => 1000,
    preparePackage: async (inv) => envelope(inv),
  });
  payments.cacheInvoice(invoice);
  await payments.reconcileObservation(over);
  const paid = await payments.orderStatus(invoice.orderId);
  expect(paid.payment).toBe('confirmed');
  expect(paid.delivery).toBe('prepared');
  expect(paid.exceptions.some((item) => item.code === 'overpayment')).toBe(true);

  const other = await seed(store, 'buyer-b');
  scanner.replaceSnapshot([], { id: 'genesis', height: 0 }, false, 1000);
  scanner.setHealth({ healthy: false, caughtUp: false, revision: { id: 'genesis', height: 0 }, checkedAt: 1000 });
  payments.cacheInvoice(other.invoice);
  await payments.reconcileObservation({
    outputId: 'out-unrelated',
    invoiceId: null,
    amountZat: other.invoice.amountZat,
    confirmations: 0,
    canonical: true,
    receivedAt: 1000,
    revision: { id: 'rev-1', height: 1 },
  });
  const waiting = await payments.orderStatus(other.invoice.orderId);
  expect(waiting.payment).toBe('awaiting');
  expect(waiting.delivery).toBe('locked');
  expect(waiting.verification).toBe('unavailable');
  expect(waiting.exceptions.some((item) => item.code === 'verification_unavailable')).toBe(true);
});

test('payments module does not offer automatic refunds', async () => {
  expect('refund' in createPayments).toBe(false);
  store = await openStore(dbPath);
  const payments = createPayments({
    store,
    scanner: new MemoryScanner(),
    now: () => 1000,
    preparePackage: async (inv) => envelope(inv),
  });
  expect('refund' in payments).toBe(false);
  expect('requestRefund' in payments).toBe(false);
});
