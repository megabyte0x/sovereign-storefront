// R3.4: a response lost across a real seller restart. The store and the
// application are closed and reopened on the same SQLite file; replaying the
// same messageId returns the same durable effect, and a changed payload under
// that id is still rejected (the inbox digest survives the restart).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import type { ChainIdentity } from '../../src/contracts/live.ts';
import type { BuyerRequest, SellerResponse } from '../../src/contracts/messages.ts';
import type { SellerStore, ServiceAvailability } from '../../src/contracts/types.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { openStore } from '../../src/seller/db.ts';
import { createInvoiceIssuer } from '../../src/seller/issuance.ts';
import { createSellerApplication } from '../../src/seller/messages.ts';
import { createPayments } from '../../src/seller/payments.ts';

const availability: ServiceAvailability = { productPublished: true, messaging: true, storageReplica: true, scanner: true };
const chain: ChainIdentity = { network: 'regtest', genesisHash: 'a'.repeat(64), consensusFingerprint: 'c'.repeat(64) };
const SELLER_KEY_ID = 'seller-key-restart';
const BUYER = 'buyer-restart';

let scratchDir = '';
let dbPath = '';
let clockMs = 1_000_000;
const now = () => clockMs;
const open: SellerStore[] = [];

beforeEach(() => {
  scratchDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-seller-restart-'));
  dbPath = join(scratchDir, 'seller.sqlite');
  const catalogue = openCatalogue({ dbPath, storage: createMemoryStorageAdapter() });
  catalogue.beginPublication({ version: 'book-v1', description: 'fixture', amountZat: '100', network: chain.network });
  catalogue.completePublication({
    version: 'book-v1', ciphertextCid: 'fixture-cid', ciphertextDigest: 'a'.repeat(64), fileSize: 1,
    sellerKeyRef: 'fixture-key', wrappedKey: new Uint8Array([1]),
  });
  catalogue.close();
  clockMs = 1_000_000;
});

afterEach(async () => {
  for (const store of open.splice(0)) await store.close().catch(() => undefined);
  rmSync(scratchDir, { recursive: true, force: true });
});

/**
 * One seller "process": a fresh store handle on the shared DB file and a fresh
 * application. The scanner is the external wallet service, so it outlives the
 * seller restart (and keeps its receiver allocations).
 */
async function boot(scanner: MemoryScanner) {
  const store = await openStore(dbPath);
  open.push(store);
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId: 'fixture-account', ttlMs: 60_000, now, availability: async () => availability,
  });
  const payments = createPayments({
    store, scanner, now,
    preparePackage: async (invoice) => ({
      orderId: invoice.orderId, productVersion: invoice.productVersion, buyerKeyId: invoice.buyerKeyId,
      encryptedEnvelope: new Uint8Array([7, 7, 7]),
    }),
  });
  const application = createSellerApplication({ store, issuer, payments, sellerKeyId: SELLER_KEY_ID, network: chain.network, now });
  return {
    application,
    async shutdown() {
      await store.close();
      open.splice(open.indexOf(store), 1);
    },
  };
}

function header(messageId: string) {
  return { version: 1 as const, messageId, sellerKeyId: SELLER_KEY_ID, network: chain.network, issuedAt: now(), expiresAt: now() + 60_000 };
}

function pay(scanner: MemoryScanner, invoice: { attribution?: { kind: string; receiver?: unknown }; amountZat: string }): void {
  if (invoice.attribution?.kind !== 'receiver') throw new Error('receiver invoice required');
  scanner.setReceiptReceiver('out-r', invoice.attribution.receiver as Parameters<typeof scanner.setReceiptReceiver>[1]);
  scanner.replaceSnapshot(
    [{ outputId: 'out-r', invoiceId: null, amountZat: invoice.amountZat, confirmations: 0, canonical: true, receivedAt: 1000, revision: { id: 'rev-1', height: 1 } }],
    { id: 'rev-10', height: 10 }, true, now(),
  );
}

/** Response minus the per-delivery header timestamps. */
function effect(response: SellerResponse): Record<string, unknown> {
  const { issuedAt: _i, expiresAt: _e, ...rest } = response;
  return rest;
}

test('a create response lost across a restart replays the same durable invoice; a changed payload is still rejected', async () => {
  const scanner = new MemoryScanner();
  const create: BuyerRequest = { ...header('msg-restart-create'), type: 'create', requestId: 'req-restart', productVersion: 'book-v1', expectedAmountZat: '100' };

  const first = await boot(scanner);
  const lost = await first.application.handle({ signerKeyId: BUYER, body: create });
  expect(lost.type).toBe('invoice');
  await first.shutdown();

  clockMs += 5_000;
  const second = await boot(scanner);
  const replay = await second.application.handle({ signerKeyId: BUYER, body: create });
  expect(effect(replay)).toEqual(effect(lost));

  const tampered: BuyerRequest = { ...create, expectedAmountZat: '101' };
  const rejected = await second.application.handle({ signerKeyId: BUYER, body: tampered });
  expect(rejected).toMatchObject({ type: 'error', code: 'invalid', inReplyTo: create.messageId });
  const otherRequest: BuyerRequest = { ...create, requestId: 'req-restart-other' };
  expect(await second.application.handle({ signerKeyId: BUYER, body: otherRequest })).toMatchObject({ type: 'error', code: 'invalid' });
  await second.shutdown();

  // Still rejected after yet another restart; the original still replays.
  const third = await boot(scanner);
  expect(await third.application.handle({ signerKeyId: BUYER, body: tampered })).toMatchObject({ type: 'error', code: 'invalid' });
  expect(effect(await third.application.handle({ signerKeyId: BUYER, body: create }))).toEqual(effect(lost));
});

test('recover and acknowledge responses lost across a restart replay the same package and the same acknowledgement', async () => {
  const scanner = new MemoryScanner();
  const first = await boot(scanner);
  const created = await first.application.handle({
    signerKeyId: BUYER, body: { ...header('msg-r-create'), type: 'create', requestId: 'req-r', productVersion: 'book-v1', expectedAmountZat: '100' },
  });
  if (created.type !== 'invoice') throw new Error('expected invoice');
  pay(scanner, created.invoice);
  const recover: BuyerRequest = { ...header('msg-r-recover'), type: 'recover', orderId: created.invoice.orderId };
  const lostDelivery = await first.application.handle({ signerKeyId: BUYER, body: recover });
  expect(lostDelivery.type).toBe('delivery');
  if (lostDelivery.type !== 'delivery') throw new Error('unreachable');
  await first.shutdown();

  const second = await boot(scanner);
  const replayedDelivery = await second.application.handle({ signerKeyId: BUYER, body: recover });
  expect(effect(replayedDelivery)).toEqual(effect(lostDelivery));
  const tamperedRecover: BuyerRequest = { ...recover, orderId: 'order-someone-else' };
  expect(await second.application.handle({ signerKeyId: BUYER, body: tamperedRecover })).toMatchObject({ type: 'error', code: 'invalid' });

  const ack: BuyerRequest = { ...header('msg-r-ack'), type: 'acknowledge', orderId: created.invoice.orderId, packageId: lostDelivery.packageId };
  const lostAck = await second.application.handle({ signerKeyId: BUYER, body: ack });
  expect(lostAck).toMatchObject({ type: 'acknowledged', orderId: created.invoice.orderId, packageId: lostDelivery.packageId });
  await second.shutdown();

  const third = await boot(scanner);
  const replayedAck = await third.application.handle({ signerKeyId: BUYER, body: ack });
  expect(effect(replayedAck)).toEqual(effect(lostAck));
  const tamperedAck: BuyerRequest = { ...ack, packageId: 'pkg-forged' };
  expect(await third.application.handle({ signerKeyId: BUYER, body: tamperedAck })).toMatchObject({ type: 'error', code: 'invalid' });
  // The delivery is still acknowledged exactly once, bound to the same package.
  const replayedDeliveryAfterAck = await third.application.handle({ signerKeyId: BUYER, body: recover });
  expect(effect(replayedDeliveryAfterAck)).toEqual(effect(lostDelivery));
});
