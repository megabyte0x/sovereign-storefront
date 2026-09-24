import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryScanner, SCANNER_MAPPING } from '../../src/adapters/scanner.ts';
import { DEFAULT_POLICY, createPayments } from '../../src/seller/payments.ts';
import { createInvoiceIssuer } from '../../src/seller/issuance.ts';
import { openStore } from '../../src/seller/db.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import type { Invoice, SellerStore, ServiceAvailability } from '../../src/contracts/types.ts';
import type { ChainIdentity } from '../../src/contracts/live.ts';

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
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-payments-'));
  dbPath = join(scratchDir, 'seller.sqlite');
  setupProduct(dbPath);
});

afterEach(async () => {
  await store?.close().catch(() => undefined);
  rmSync(scratchDir, { recursive: true, force: true });
});

async function issueInvoice(scanner: MemoryScanner, requestId: string, buyerKeyId = 'buyer-a'): Promise<Invoice> {
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId, ttlMs: 60_000, now: () => 1000,
    availability: async () => availability,
  });
  return issuer.issue({ requestId, buyerKeyId, productVersion: 'book-v1', expectedAmountZat: '100' });
}

/** Sets up a scanner receipt that pays the given invoice's exact receiver, with enough confirmations to confirm by default. */
function payInvoice(
  scanner: MemoryScanner,
  invoice: Invoice,
  overrides: {
    outputId?: string; canonical?: boolean; minedHeight?: number; confirmations?: number;
    checkedAt?: number; complete?: boolean;
  } = {},
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
  if (overrides.complete === false) scanner.stopConsumer();
  return { outputId, minedRevision: minedRev, tipRevision: tipRev };
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
  expect(DEFAULT_POLICY.minConfirmations).toBe(10);
});

test('reconcileFromScanner commits snapshot+observations+settlements together and authorizes release', async () => {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const invoice = await issueInvoice(scanner, 'req-1');
  payInvoice(scanner, invoice);
  const payments = createPayments({
    store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv),
  });
  expect(await store.getScanSnapshot()).toBeNull();
  await payments.reconcileFromScanner();
  expect(await store.getScanSnapshot()).not.toBeNull();
  expect(await store.getDelivery(invoice.orderId)).toBe('prepared');
  const decision = await payments.authorizeRelease(invoice.orderId);
  expect(decision.disclose).toBe(true);
  expect(decision.reason).toBe('first_release');
});

test('a newer generation at a lower height revokes a previously confirmed payment', async () => {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const invoice = await issueInvoice(scanner, 'req-2');
  payInvoice(scanner, invoice, { minedHeight: 1 });
  const payments = createPayments({ store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv) });
  await payments.reconcileFromScanner();
  expect((await payments.orderStatus(invoice.orderId)).payment).toBe('confirmed');

  // A reorg drops the chain to a lower, newer-generation tip that no longer includes the receipt.
  scanner.replaceSnapshot([], { id: 'rev-5', height: 5 }, true, 1000);
  await payments.reconcileFromScanner();
  const status = await payments.orderStatus(invoice.orderId);
  expect(status.payment).not.toBe('confirmed');
});

test('a receipt at the wrong receiver never confirms an unrelated invoice', async () => {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const invoice = await issueInvoice(scanner, 'req-3');
  const other = await issueInvoice(scanner, 'req-3b', 'buyer-b');
  if (other.attribution?.kind !== 'receiver') throw new Error('receiver invoice required');
  // Pay the OTHER invoice's receiver, not this invoice's.
  const rev = { id: 'rev-1', height: 1 };
  scanner.setReceiptReceiver('out-a', other.attribution.receiver);
  scanner.replaceSnapshot(
    [{ outputId: 'out-a', invoiceId: null, amountZat: invoice.amountZat, confirmations: 0, canonical: true, receivedAt: 1000, revision: rev }],
    { id: 'rev-10', height: 10 },
    true,
    1000,
  );
  const payments = createPayments({ store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv) });
  await payments.reconcileFromScanner();
  expect((await payments.orderStatus(invoice.orderId)).payment).toBe('awaiting');
  expect((await payments.orderStatus(other.orderId)).payment).toBe('confirmed');
});

test('unrelated fresh health cannot authorize an old, no-longer-caught-up receipt', async () => {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const invoice = await issueInvoice(scanner, 'req-4');
  payInvoice(scanner, invoice, { checkedAt: 1000 });
  const payments = createPayments({ store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv) });
  await payments.reconcileFromScanner();
  expect(await store.getDelivery(invoice.orderId)).toBe('prepared');

  // "Fresh" health but not caught up: must not authorize release.
  scanner.setHealth({ checkedAt: 5000, caughtUp: false });
  const decision = await payments.authorizeRelease(invoice.orderId);
  expect(decision.disclose).toBe(false);
});

test('missing receipt in a complete snapshot revokes a previously confirmed payment', async () => {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const invoice = await issueInvoice(scanner, 'req-5');
  payInvoice(scanner, invoice);
  const payments = createPayments({ store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv) });
  await payments.reconcileFromScanner();
  expect((await payments.orderStatus(invoice.orderId)).payment).toBe('confirmed');

  // Complete snapshot with no receipts at all: the prior receipt has vanished.
  scanner.replaceSnapshot([], { id: 'rev-30', height: 30 }, true, 1000);
  await payments.reconcileFromScanner();
  expect((await payments.orderStatus(invoice.orderId)).payment).not.toBe('confirmed');
});

test('a partial (incomplete) snapshot does not commit', async () => {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const invoice = await issueInvoice(scanner, 'req-6');
  payInvoice(scanner, invoice, { complete: false });
  const payments = createPayments({ store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv) });
  await payments.reconcileFromScanner();
  expect(await store.getScanSnapshot()).toBeNull();
  expect(await store.getDelivery(invoice.orderId)).toBe('locked');
});

test('a future checkedAt fails and does not commit', async () => {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const invoice = await issueInvoice(scanner, 'req-7');
  payInvoice(scanner, invoice, { checkedAt: 999_999_999 });
  const payments = createPayments({ store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv) });
  await payments.reconcileFromScanner();
  expect(await store.getScanSnapshot()).toBeNull();
  expect(await store.getDelivery(invoice.orderId)).toBe('locked');
});

test('scanner outage sets verification unavailable and does not mark a confirmed purchase unpaid', async () => {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const invoice = await issueInvoice(scanner, 'req-8');
  payInvoice(scanner, invoice);
  const payments = createPayments({ store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv) });
  await payments.reconcileFromScanner();
  expect((await payments.orderStatus(invoice.orderId)).payment).toBe('confirmed');

  scanner.setHealth({ healthy: false, caughtUp: false });
  const down = await payments.orderStatus(invoice.orderId);
  expect(down.payment).toBe('confirmed');
  expect(down.verification).toBe('unavailable');
  expect(down.exceptions.some((item) => item.code === 'verification_unavailable')).toBe(true);
});

test('crash between commitSnapshot and prepare re-prepares on the next reconcile without disclosing', async () => {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const invoice = await issueInvoice(scanner, 'req-9');
  payInvoice(scanner, invoice);
  const payments = createPayments({
    store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv),
    hooks: { crashAfterCommit: () => { throw new Error('injected crash after commit'); } },
  });
  await expect(payments.reconcileFromScanner()).rejects.toThrow(/after commit/);
  expect(await store.getScanSnapshot()).not.toBeNull();
  expect(await store.getDelivery(invoice.orderId)).toBe('locked');
  await store.close();

  store = await openStore(dbPath);
  const restarted = createPayments({ store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv) });
  await restarted.reconcileFromScanner();
  expect(await store.getDelivery(invoice.orderId)).toBe('prepared');
  const decision = await restarted.authorizeRelease(invoice.orderId);
  expect(decision.disclose).toBe(true);
  expect(decision.reason).toBe('first_release');
});

test('hydrate invoices from sqlite after restart and re-authorize from a fresh reconcile', async () => {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const invoice = await issueInvoice(scanner, 'req-10');
  payInvoice(scanner, invoice);
  const payments = createPayments({ store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv) });
  await payments.reconcileFromScanner();
  expect((await payments.orderStatus(invoice.orderId)).payment).toBe('confirmed');
  await store.close();

  store = await openStore(dbPath);
  const restarted = createPayments({ store, scanner, now: () => 1000, preparePackage: async (inv) => envelope(inv) });
  expect(await restarted.knownOrderIds()).toContain(invoice.orderId);
  await restarted.reconcileFromScanner();
  const decision = await restarted.authorizeRelease(invoice.orderId);
  expect(decision.disclose).toBe(true);
});
