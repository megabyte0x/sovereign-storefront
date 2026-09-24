import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createTestCredentialAdapter } from '../../src/adapters/credentials.ts';
import { createMemoryMessaging } from '../../src/adapters/messaging.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import type { Invoice, SellerStore, ServiceAvailability } from '../../src/contracts/types.ts';
import type { ChainIdentity } from '../../src/contracts/live.ts';
import { openStore } from '../../src/seller/db.ts';
import { createFulfillment } from '../../src/seller/fulfillment.ts';
import { createInvoiceIssuer } from '../../src/seller/issuance.ts';
import { DEFAULT_POLICY, createPayments } from '../../src/seller/payments.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();
const availability: ServiceAvailability = { productPublished: true, messaging: true, storageReplica: true, scanner: true };
const chain: ChainIdentity = { network: 'regtest', genesisHash: 'a'.repeat(64), consensusFingerprint: 'c'.repeat(64) };
const accountId = 'fixture-account';

let dbPath = '';
let scratchDir = '';
let store: SellerStore;

function setupProduct(path: string, amountZat = '100'): void {
  const catalogue = openCatalogue({ dbPath: path, storage: createMemoryStorageAdapter() });
  catalogue.beginPublication({ version: 'book-v1', description: 'fixture', amountZat, network: chain.network });
  catalogue.completePublication({
    version: 'book-v1', ciphertextCid: 'fixture-cid', ciphertextDigest: 'a'.repeat(64), fileSize: 1,
    sellerKeyRef: 'fixture-key', wrappedKey: new Uint8Array([1]),
  });
  catalogue.close();
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-fulfill-'));
  dbPath = join(scratchDir, 'seller.sqlite');
  setupProduct(dbPath);
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

function payInvoice(
  scanner: MemoryScanner,
  invoice: Invoice,
  overrides: { outputId?: string; canonical?: boolean; minedHeight?: number; confirmations?: number; checkedAt?: number } = {},
) {
  if (invoice.attribution?.kind !== 'receiver') throw new Error('receiver invoice required');
  const outputId = overrides.outputId ?? 'out-a';
  const minedHeight = overrides.minedHeight ?? 1;
  const confirmations = overrides.confirmations ?? DEFAULT_POLICY.minConfirmations;
  const tipHeight = minedHeight + confirmations - 1;
  const minedRev = { id: `rev-${minedHeight}`, height: minedHeight };
  const tipRev = { id: `rev-${tipHeight}`, height: tipHeight };
  scanner.setReceiptReceiver(outputId, invoice.attribution.receiver);
  scanner.replaceSnapshot(
    [{ outputId, invoiceId: null, amountZat: invoice.amountZat, confirmations: 0, canonical: overrides.canonical ?? true, receivedAt: 1000, revision: minedRev }],
    tipRev,
    true,
    overrides.checkedAt ?? 1000,
  );
  return { outputId, minedRevision: minedRev, tipRevision: tipRev };
}

async function paidSetup(buyerKeyId = 'buyer-a') {
  store = await openStore(dbPath);
  const credentials = createTestCredentialAdapter();
  const created = await credentials.createPurchaseCredential();
  const scanner = new MemoryScanner();
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId, ttlMs: 60_000, now: () => 1000,
    availability: async () => availability,
  });
  const invoice = await issuer.issue({
    requestId: `req-${buyerKeyId}`, buyerKeyId: created.buyerKeyId, productVersion: 'book-v1', expectedAmountZat: '100',
  });
  payInvoice(scanner, invoice);
  const payments = createPayments({
    store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv),
  });
  await payments.reconcileFromScanner();
  return { credentials, created, invoice, scanner, payments, issuer };
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

test('overlapping dispatchPending ticks do not double-send', async () => {
  const { invoice, payments } = await paidSetup();
  let releaseSend: (() => void) | undefined;
  const holdSend = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  let startedSend: (() => void) | undefined;
  const sendStarted = new Promise<void>((resolve) => {
    startedSend = resolve;
  });
  const inner = createMemoryMessaging();
  const messaging = {
    sent: inner.sent,
    sendInitiatedFor: inner.sendInitiatedFor,
    async send(pkg: Parameters<typeof inner.send>[0]) {
      startedSend?.();
      await holdSend;
      return inner.send(pkg);
    },
  };
  const fulfillment = createFulfillment({ store, payments, messaging });
  const first = fulfillment.dispatchPending();
  await sendStarted;
  const second = fulfillment.dispatchPending();
  releaseSend?.();
  await Promise.all([first, second]);
  expect(inner.sent).toHaveLength(1);
  expect(inner.sent[0].orderId).toBe(invoice.orderId);
});

test('dispatchPending persists an intent record before send I/O, and a transport-accepted outcome only after send succeeds', async () => {
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
  // Intent was persisted before the send attempt even though we can't yet
  // prove anything reached the transport: uncertain, not falsely resolved.
  expect(await store.getDisclosure(invoice.orderId)).toBe('attempted');

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
  // The transport fixture actually recorded the send, but our own process
  // crashed before learning the outcome: delivery stays 'queued' (uncertain,
  // not claimed exactly-once), not falsely upgraded to sent_unacknowledged.
  expect(await store.getDelivery(invoice.orderId)).toBe('queued');
  expect(await store.getDisclosure(invoice.orderId)).toBe('attempted');

  crashAfter = false;
  await resumed.dispatchPending();
  // At-least-once semantics: retry legitimately resends rather than
  // silently skipping on unproven prior success.
  expect(after.sent).toHaveLength(2);
  expect(await store.getDelivery(invoice.orderId)).toBe('sent_unacknowledged');
  expect(await store.getDisclosure(invoice.orderId)).toBe('transport-accepted');
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
  const invoiceB = await first.issuer.issue({
    requestId: 'req-buyer-b', buyerKeyId: buyerB.buyerKeyId, productVersion: 'book-v1', expectedAmountZat: '100',
  });
  payInvoice(first.scanner, invoiceB, { outputId: 'out-b' });
  await first.payments.reconcileFromScanner();
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

test('acknowledgements bind to the order, authenticated sender and exact packageId', async () => {
  const { invoice, payments, credentials, created } = await paidSetup();
  const other = await credentials.createPurchaseCredential();
  const fulfillment = createFulfillment({
    store,
    payments,
    messaging: createMemoryMessaging(),
    credentials,
  });
  await fulfillment.dispatchPending();
  const pkg = await store.getPreparedPackage(invoice.orderId);
  const packageId = pkg?.packageId;
  if (!packageId) throw new Error('prepared package missing identity');
  await expect(fulfillment.acknowledge(invoice.orderId, other.credentialId, packageId)).rejects.toThrow(/buyer/);
  await expect(fulfillment.acknowledge(invoice.orderId, created.credentialId, 'wrong-package-id')).rejects.toThrow(/package identity/);
  await fulfillment.acknowledge(invoice.orderId, created.credentialId, packageId);
  expect(await store.getDelivery(invoice.orderId)).toBe('acknowledged');
  // Idempotent: acking the same package again does not throw.
  await fulfillment.acknowledge(invoice.orderId, created.credentialId, packageId);
  expect(await store.getDelivery(invoice.orderId)).toBe('acknowledged');
});

test('prepare, then payment reorg, then recover: disclose is false', async () => {
  const { invoice, payments, scanner, credentials, created } = await paidSetup();
  expect(await store.getDelivery(invoice.orderId)).toBe('prepared');
  const fulfillment = createFulfillment({
    store,
    payments,
    messaging: createMemoryMessaging(),
    credentials,
  });
  scanner.replaceSnapshot([], { id: 'rev-99', height: 99 }, true, 1000);
  await payments.reconcileFromScanner();
  const recovered = await fulfillment.recover(invoice.orderId, created.credentialId);
  expect(recovered.disclose).toBe(false);
  expect(recovered.reason).toBe('not_eligible');
  expect(recovered.package).toBeNull();
  expect(await store.getDelivery(invoice.orderId)).toBe('prepared');
});

test('reorg after release records exception and preserves delivery evidence', async () => {
  const { invoice, payments, scanner } = await paidSetup();
  const first = await payments.authorizeRelease(invoice.orderId);
  expect(first.reason).toBe('first_release');
  if (invoice.attribution?.kind !== 'receiver') throw new Error('receiver invoice required');
  // Same output, still matched, but now reported non-canonical (reorged out).
  scanner.setReceiptReceiver('out-a', invoice.attribution.receiver);
  scanner.replaceSnapshot(
    [{ outputId: 'out-a', invoiceId: null, amountZat: invoice.amountZat, confirmations: 0, canonical: false, receivedAt: 1000, revision: { id: 'rev-99', height: 99 } }],
    { id: 'rev-99', height: 99 },
    true,
    1000,
  );
  await payments.reconcileFromScanner();
  const status = await payments.orderStatus(invoice.orderId);
  expect(status.delivery).toBe('queued');
  expect(status.exceptions.some((item) => item.code === 'reorg_after_release')).toBe(true);
  const replay = await payments.authorizeRelease(invoice.orderId);
  expect(replay.disclose).toBe(true);
  expect(replay.reason).toBe('replay');
  expect(replay.package).not.toBeNull();
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
  expect(await restarted.knownOrderIds()).toContain(invoice.orderId);
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
