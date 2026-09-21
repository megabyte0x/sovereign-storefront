import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createTestCredentialAdapter } from '../../src/adapters/credentials.ts';
import { createMemoryMessaging } from '../../src/adapters/messaging.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import type { Invoice, Observation, SellerStore } from '../../src/contracts/types.ts';
import { openStore } from '../../src/seller/db.ts';
import { createFulfillment } from '../../src/seller/fulfillment.ts';
import { DEFAULT_POLICY, createPayments } from '../../src/seller/payments.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();
const availability = {productPublished: true, messaging: true, storageReplica: true, scanner: true};

let dbPath = '';
let scratchDir = '';
let store: SellerStore;

beforeEach(() => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-fulfill-'));
  dbPath = join(scratchDir, 'seller.sqlite');
});

afterEach(async () => {
  await store?.close().catch(() => undefined);
  rmSync(scratchDir, { recursive: true, force: true });
});

function envelope(invoice: Invoice) {
  return {
    orderId: invoice.orderId,
    productVersion: invoice.productVersion,
    buyerKeyId: invoice.buyerKeyId,
    encryptedEnvelope: new Uint8Array([3, 3, 3]),
  };
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

async function paidSetup(buyerKeyId = 'buyer-a') {
  store = await openStore(dbPath);
  const credentials = createTestCredentialAdapter();
  const created = await credentials.createPurchaseCredential();
  const order = await store.createOrder({
    requestId: `req-${buyerKeyId}`,
    buyerKeyId: created.buyerKeyId,
    productVersion: 'book-v1',
  });
  const invoice = await store.getOrCreateInvoice({
    orderId: order.id,
    buyerKeyId: created.buyerKeyId,
    productVersion: 'book-v1',
    now: 1000,
    availability,
  });
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
  return { credentials, created, invoice, scanner, payments, receipt };
}

test('authorizeRelease is the only first-disclosure gate and failed CAS does not disclose', async () => {
  const { invoice, payments } = await paidSetup();
  expect(await store.getDelivery(invoice.orderId)).toBe('prepared');
  const first = await payments.authorizeRelease(invoice.orderId);
  expect(first).toMatchObject({ disclose: true, reason: 'first_release', delivery: 'queued' });
  expect(first.package?.orderId).toBe(invoice.orderId);
  const replay = await payments.authorizeRelease(invoice.orderId);
  expect(replay).toMatchObject({ disclose: true, reason: 'replay', delivery: 'queued' });
  expect(replay.package?.encryptedEnvelope).toEqual(new Uint8Array([3, 3, 3]));
});

test('worker send path authorizes, sends, then records the attempt as possible disclosure', async () => {
  const { invoice, payments } = await paidSetup();
  const messaging = createMemoryMessaging();
  const fulfillment = createFulfillment({ store, payments, messaging });
  await fulfillment.dispatchPending();
  expect(messaging.sent).toHaveLength(1);
  expect(messaging.sent[0].orderId).toBe(invoice.orderId);
  expect(await store.getDelivery(invoice.orderId)).toBe('sent_unacknowledged');
});

test('two dispatchPending calls after one successful send do not double-send', async () => {
  const { invoice, payments } = await paidSetup();
  const messaging = createMemoryMessaging();
  const fulfillment = createFulfillment({ store, payments, messaging });
  await fulfillment.dispatchPending();
  expect(messaging.sent).toHaveLength(1);
  await fulfillment.dispatchPending();
  expect(messaging.sent).toHaveLength(1);
  expect(await store.getDelivery(invoice.orderId)).toBe('sent_unacknowledged');
});

test('crash before send does not authorize a second payment; crash after send persists sent_unacknowledged', async () => {
  const { invoice, payments, scanner } = await paidSetup();
  let crashBefore = true;
  const messaging = createMemoryMessaging({
    crashBeforeSend: () => {
      if (crashBefore) throw new Error('injected crash before send');
    },
  });
  const fulfillment = createFulfillment({ store, payments, messaging });
  await expect(fulfillment.dispatchPending()).rejects.toThrow(/before send/);
  expect(messaging.sendInitiatedFor).toHaveLength(0);
  expect(await store.getDelivery(invoice.orderId)).toBe('queued');

  crashBefore = false;
  let crashAfter = true;
  const after = createMemoryMessaging({
    crashAfterSend: () => {
      if (crashAfter) throw new Error('injected crash after send');
    },
  });
  const resumed = createFulfillment({ store, payments, messaging: after });
  await expect(resumed.dispatchPending()).rejects.toThrow(/after send/);
  expect(after.sendInitiatedFor).toEqual([invoice.orderId]);
  expect(await store.getDelivery(invoice.orderId)).toBe('sent_unacknowledged');

  crashAfter = false;
  await resumed.dispatchPending();
  expect(after.sent).toHaveLength(2);
  expect(await store.getDelivery(invoice.orderId)).toBe('sent_unacknowledged');
  expect((await payments.orderStatus(invoice.orderId)).payment).toBe('confirmed');
  expect(scanner).toBeDefined();
});

test('authenticated recovery proves the buyer then calls authorizeRelease; wrong buyers never reach disclosure', async () => {
  const { invoice, payments, credentials, created } = await paidSetup();
  const other = await credentials.createPurchaseCredential();
  const fulfillment = createFulfillment({
    store,
    payments,
    messaging: createMemoryMessaging(),
    credentials,
  });
  await expect(fulfillment.recover(invoice.orderId, '')).rejects.toThrow();
  await expect(fulfillment.recover(invoice.orderId, other.credentialId)).rejects.toThrow(/buyer/);
  await expect(fulfillment.status(invoice.orderId, other.credentialId)).rejects.toThrow(/buyer/);
  await expect(fulfillment.status(invoice.orderId, '')).rejects.toThrow();

  const released = await fulfillment.recover(invoice.orderId, created.credentialId);
  expect(released.disclose).toBe(true);
  expect(released.reason).toBe('first_release');
  const status = await fulfillment.status(invoice.orderId, created.credentialId);
  expect(status.payment).toBe('confirmed');
  expect(status.delivery).toBe('queued');
});

test('buyer A credential cannot recover or status buyer B order before any disclosure decision', async () => {
  const first = await paidSetup('buyer-a');
  const credentials = first.credentials;
  const buyerB = await credentials.createPurchaseCredential();
  const orderB = await store.createOrder({
    requestId: 'req-buyer-b',
    buyerKeyId: buyerB.buyerKeyId,
    productVersion: 'book-v1',
  });
  const invoiceB = await store.getOrCreateInvoice({
    orderId: orderB.id,
    buyerKeyId: buyerB.buyerKeyId,
    productVersion: 'book-v1',
    now: 1000,
    availability,
  });
  first.payments.cacheInvoice(invoiceB);
  const receiptB = observation(invoiceB, { outputId: 'out-b' });
  first.scanner.replaceSnapshot(
    [observation(first.invoice), receiptB],
    receiptB.revision,
    true,
    1000,
  );
  await first.payments.reconcileObservation(receiptB);
  const fulfillment = createFulfillment({
    store,
    payments: first.payments,
    messaging: createMemoryMessaging(),
    credentials,
  });
  await expect(fulfillment.recover(invoiceB.orderId, first.created.credentialId)).rejects.toThrow(/buyer/);
  await expect(fulfillment.status(invoiceB.orderId, first.created.credentialId)).rejects.toThrow(/buyer/);
  expect(await store.getDelivery(invoiceB.orderId)).toBe('prepared');
  const owned = await fulfillment.recover(invoiceB.orderId, buyerB.credentialId);
  expect(owned.disclose).toBe(true);
});

test('acknowledgements bind to the order and authenticated sender', async () => {
  const { invoice, payments, credentials, created } = await paidSetup();
  const other = await credentials.createPurchaseCredential();
  const fulfillment = createFulfillment({
    store,
    payments,
    messaging: createMemoryMessaging(),
    credentials,
  });
  await fulfillment.dispatchPending();
  await expect(fulfillment.acknowledge(invoice.orderId, other.credentialId)).rejects.toThrow(/buyer/);
  await fulfillment.acknowledge(invoice.orderId, created.credentialId);
  expect(await store.getDelivery(invoice.orderId)).toBe('acknowledged');
});

test('prepare, crash before send, payment reorg, recover: disclose is false', async () => {
  const { invoice, payments, scanner, credentials, created, receipt } = await paidSetup();
  expect(await store.getDelivery(invoice.orderId)).toBe('prepared');
  const fulfillment = createFulfillment({
    store,
    payments,
    messaging: createMemoryMessaging(),
    credentials,
  });
  const reorged: Observation = {
    ...receipt,
    canonical: false,
    confirmations: 0,
    revision: { id: 'rev-11', height: 11 },
  };
  scanner.replaceSnapshot([reorged], reorged.revision, true, 1000);
  await payments.reconcileObservation(reorged);
  const recovered = await fulfillment.recover(invoice.orderId, created.credentialId);
  expect(recovered.disclose).toBe(false);
  expect(recovered.reason).toBe('not_eligible');
  expect(recovered.package).toBeNull();
  expect(await store.getDelivery(invoice.orderId)).toBe('prepared');
});

test('prepare then reorg before authorizeRelease holds disclosure', async () => {
  store = await openStore(dbPath);
  const order = await store.createOrder({requestId: 'hold', buyerKeyId: 'buyer-hold', productVersion: 'book-v1'});
  const invoice = await store.getOrCreateInvoice({
    orderId: order.id, buyerKeyId: 'buyer-hold', productVersion: 'book-v1', now: 1000, availability,
  });
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
  const reorged: Observation = {
    ...receipt,
    canonical: false,
    confirmations: 0,
    revision: { id: 'rev-11', height: 11 },
  };
  scanner.replaceSnapshot([reorged], reorged.revision, true, 1000);
  await payments.reconcileObservation(reorged);
  const decision = await payments.authorizeRelease(invoice.orderId);
  expect(decision.disclose).toBe(false);
  expect(decision.reason).toBe('not_eligible');
  expect(await store.getDelivery(invoice.orderId)).toBe('prepared');
  expect((await payments.orderStatus(invoice.orderId)).payment).toBe('reorged');
});

test('reorg after release records exception and preserves delivery evidence', async () => {
  const { invoice, payments, receipt, scanner } = await paidSetup();
  const first = await payments.authorizeRelease(invoice.orderId);
  expect(first.reason).toBe('first_release');
  const reorged: Observation = {
    ...receipt,
    canonical: false,
    confirmations: 0,
    revision: { id: 'rev-11', height: 11 },
  };
  scanner.replaceSnapshot([reorged], reorged.revision, true, 1000);
  await payments.reconcileObservation(reorged);
  const status = await payments.orderStatus(invoice.orderId);
  expect(status.delivery).toBe('queued');
  expect(status.exceptions.some((item) => item.code === 'reorg_after_release')).toBe(true);
  const replay = await payments.authorizeRelease(invoice.orderId);
  expect(replay.disclose).toBe(true);
  expect(replay.reason).toBe('replay');
  expect(replay.package).not.toBeNull();
});

test('concurrent reconciliation cannot sneak a reorg between eligibility and authorization', async () => {
  const { invoice, payments, receipt, scanner } = await paidSetup();
  const reorged: Observation = {
    ...receipt,
    canonical: false,
    confirmations: 0,
    revision: { id: 'rev-11', height: 11 },
  };
  scanner.replaceSnapshot([reorged], reorged.revision, true, 1000);
  const results = await Promise.all([
    payments.reconcileObservation(reorged),
    payments.authorizeRelease(invoice.orderId),
  ]);
  const decision = results[1];
  const status = await payments.orderStatus(invoice.orderId);
  if (decision.disclose) {
    expect(decision.reason).toBe('first_release');
    expect(status.delivery).toBe('queued');
    expect(status.exceptions.some((item) => item.code === 'reorg_after_release')).toBe(true);
  } else {
    expect(decision.reason).toBe('not_eligible');
    expect(status.delivery).toBe('prepared');
    expect(status.payment).toBe('reorged');
  }
});

test('restart recaches invoices and rescans before authorizeRelease and dispatchPending succeed', async () => {
  const { invoice, scanner, credentials } = await paidSetup();
  expect(await store.getDelivery(invoice.orderId)).toBe('prepared');
  await store.close();

  store = await openStore(dbPath);
  const restarted = createPayments({
    store,
    scanner,
    now: () => 1000,
    preparePackage: async (inv) => envelope(inv),
  });
  expect(restarted.knownOrderIds()).toEqual([]);
  restarted.cacheInvoice(invoice);
  await restarted.reconcileFromScanner();
  const messaging = createMemoryMessaging();
  const fulfillment = createFulfillment({
    store,
    payments: restarted,
    messaging,
    credentials,
  });
  const decision = await restarted.authorizeRelease(invoice.orderId);
  expect(decision.disclose).toBe(true);
  expect(decision.reason).toBe('first_release');
  await fulfillment.dispatchPending();
  expect(messaging.sent).toHaveLength(1);
  expect(messaging.sent[0].orderId).toBe(invoice.orderId);
  expect(await store.getDelivery(invoice.orderId)).toBe('sent_unacknowledged');
});
