import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { DEFAULT_POLICY, createPayments } from '../../src/seller/payments.ts';
import { createInvoiceIssuer } from '../../src/seller/issuance.ts';
import { openStore } from '../../src/seller/db.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { validateSnapshot } from '../../src/contracts/live-validation.ts';
import { fixtureSnapshot } from '../support/live-fixtures.ts';
import type { SellerStore, ServiceAvailability } from '../../src/contracts/types.ts';
import type { ChainIdentity } from '../../src/contracts/live.ts';

// Since NU6.3 a payment to an Orchard receiver is recorded in the Ironwood pool,
// which shares the Orchard receiver. The scanner reports it as pool "ironwood".

const scratchRoot = process.env.TMPDIR ?? tmpdir();
const availability: ServiceAvailability = { productPublished: true, messaging: true, storageReplica: true, scanner: true };
const chain: ChainIdentity = { network: 'regtest', genesisHash: 'a'.repeat(64), consensusFingerprint: 'c'.repeat(64) };
let scratchDir = '';
let dbPath = '';
let store: SellerStore | undefined;

beforeEach(() => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-ironwood-'));
  dbPath = join(scratchDir, 'seller.sqlite');
  const catalogue = openCatalogue({ dbPath, storage: createMemoryStorageAdapter() });
  catalogue.beginPublication({ version: 'book-v1', description: 'fixture', amountZat: '100', network: chain.network });
  catalogue.completePublication({
    version: 'book-v1', ciphertextCid: 'fixture-cid', ciphertextDigest: 'a'.repeat(64), fileSize: 1,
    sellerKeyRef: 'fixture-key', wrappedKey: new Uint8Array([1]),
  });
  catalogue.close();
});

afterEach(async () => {
  await store?.close().catch(() => undefined);
  store = undefined;
  rmSync(scratchDir, { recursive: true, force: true });
});

test('snapshot validation accepts ironwood receipts and still rejects other pools', () => {
  const snapshot = fixtureSnapshot();
  const ironwood = { ...snapshot, receipts: [{ ...snapshot.receipts[0], pool: 'ironwood' }] };
  expect(validateSnapshot(ironwood).receipts[0].pool).toBe('ironwood');
  expect(() => validateSnapshot({ ...snapshot, receipts: [{ ...snapshot.receipts[0], pool: 'sapling' }] }))
    .toThrow(/pool/);
});

test('an ironwood receipt at the invoice receiver confirms the invoice and authorizes release', async () => {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId: 'fixture-account', ttlMs: 60_000, now: () => 1000,
    availability: async () => availability,
  });
  const invoice = await issuer.issue({ requestId: 'req-iw', buyerKeyId: 'buyer-a', productVersion: 'book-v1', expectedAmountZat: '100' });
  if (invoice.attribution?.kind !== 'receiver') throw new Error('receiver invoice required');
  scanner.setReceiptReceiver('out-iw', invoice.attribution.receiver);
  scanner.setReceiptPool('out-iw', 'ironwood');
  const confirmations = DEFAULT_POLICY.minConfirmations;
  scanner.replaceSnapshot(
    [{ outputId: 'out-iw', invoiceId: null, amountZat: invoice.amountZat, confirmations: 0, canonical: true, receivedAt: 1000, revision: { id: 'rev-1', height: 1 } }],
    { id: `rev-${confirmations}`, height: confirmations },
    true,
    1000,
  );
  expect((await scanner.snapshot()).receipts[0].pool).toBe('ironwood');

  const payments = createPayments({
    store, scanner, now: () => 1000,
    preparePackage: async (inv) => ({ orderId: inv.orderId, productVersion: inv.productVersion, buyerKeyId: inv.buyerKeyId, encryptedEnvelope: new Uint8Array([7]) }),
  });
  await payments.reconcileFromScanner();
  expect((await payments.orderStatus(invoice.orderId)).payment).toBe('confirmed');
  expect((await payments.authorizeRelease(invoice.orderId)).disclose).toBe(true);
});
