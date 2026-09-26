import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createTestCredentialAdapter } from '../../src/adapters/credentials.ts';
import { createMemoryMessaging } from '../../src/adapters/messaging.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import type { SellerStore, ServiceAvailability } from '../../src/contracts/types.ts';
import type { ChainIdentity } from '../../src/contracts/live.ts';
import type { BuyerRequest } from '../../src/contracts/messages.ts';
import { openStore } from '../../src/seller/db.ts';
import { createFulfillment } from '../../src/seller/fulfillment.ts';
import { createInvoiceIssuer } from '../../src/seller/issuance.ts';
import { createSellerApplication } from '../../src/seller/messages.ts';
import { attachSellerApplication } from '../../src/seller/messages.ts';
import { DEFAULT_POLICY, createPayments } from '../../src/seller/payments.ts';
import { WalletScannerUnavailableError } from '../../src/adapters/wallet-scanner.ts';
import { createOperationalLogger } from '../../src/ops/log.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();
const availability: ServiceAvailability = { productPublished: true, messaging: true, storageReplica: true, scanner: true };
const chain: ChainIdentity = { network: 'regtest', genesisHash: 'a'.repeat(64), consensusFingerprint: 'c'.repeat(64) };
const accountId = 'fixture-account';
const SELLER_KEY_ID = 'seller-key-1';

let dbPath = '';
let scratchDir = '';
let store: SellerStore;
let clockMs = 1_000_000;
const now = () => clockMs;

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
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-seller-msg-'));
  dbPath = join(scratchDir, 'seller.sqlite');
  setupProduct(dbPath);
  clockMs = 1_000_000;
});

afterEach(async () => {
  await store?.close().catch(() => undefined);
  rmSync(scratchDir, { recursive: true, force: true });
});

function header(overrides: Partial<Pick<BuyerRequest, 'messageId' | 'issuedAt' | 'expiresAt' | 'sellerKeyId' | 'network'>> = {}) {
  return {
    version: 1 as const,
    messageId: overrides.messageId ?? `msg-${Math.random().toString(16).slice(2)}`,
    sellerKeyId: overrides.sellerKeyId ?? SELLER_KEY_ID,
    network: overrides.network ?? chain.network,
    issuedAt: overrides.issuedAt ?? now(),
    expiresAt: overrides.expiresAt ?? now() + 60_000,
  };
}

async function harness() {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId, ttlMs: 60_000, now,
    availability: async () => availability,
  });
  const payments = createPayments({
    store, scanner, now,
    preparePackage: async (invoice) => ({
      orderId: invoice.orderId, productVersion: invoice.productVersion, buyerKeyId: invoice.buyerKeyId,
      encryptedEnvelope: new Uint8Array([9, 9, 9]),
    }),
  });
  const messaging = createMemoryMessaging();
  const fulfillment = createFulfillment({ store, payments, messaging });
  const application = createSellerApplication({
    store, issuer, payments, sellerKeyId: SELLER_KEY_ID, network: chain.network, now,
  });
  return { store, scanner, issuer, payments, messaging, fulfillment, application };
}

function payInvoice(scanner: MemoryScanner, invoice: { attribution?: { kind: string; receiver?: unknown }; amountZat: string }) {
  if (invoice.attribution?.kind !== 'receiver') throw new Error('receiver invoice required');
  scanner.setReceiptReceiver('out-a', invoice.attribution.receiver as Parameters<typeof scanner.setReceiptReceiver>[1]);
  scanner.replaceSnapshot(
    [{ outputId: 'out-a', invoiceId: null, amountZat: invoice.amountZat, confirmations: 0, canonical: true, receivedAt: 1000, revision: { id: 'rev-1', height: 1 } }],
    { id: 'rev-10', height: 10 },
    true,
    now(),
  );
}

test('signed create returns an invoice in reply to the request, bound to the requesting signer', async () => {
  const { application } = await harness();
  const createRequest: BuyerRequest = {
    ...header(), type: 'create', requestId: 'req-1', productVersion: 'book-v1', expectedAmountZat: '100',
  };
  const response = await application.handle({ signerKeyId: 'buyer-1', body: createRequest });
  expect(response.type).toBe('invoice');
  expect(response.inReplyTo).toBe(createRequest.messageId);
  expect(response.buyerKeyId).toBe('buyer-1');
  expect(response.sellerKeyId).toBe(SELLER_KEY_ID);
  if (response.type !== 'invoice') throw new Error('unreachable');
  expect(response.invoice.buyerKeyId).toBe('buyer-1');
  expect(response.invoice.attribution.kind).toBe('receiver');
});

test('duplicate create with identical payload replays the same durable invoice, not a second allocation', async () => {
  const { application } = await harness();
  const createRequest: BuyerRequest = {
    ...header({ messageId: 'msg-fixed' }), type: 'create', requestId: 'req-dup', productVersion: 'book-v1', expectedAmountZat: '100',
  };
  const first = await application.handle({ signerKeyId: 'buyer-1', body: createRequest });
  const second = await application.handle({ signerKeyId: 'buyer-1', body: createRequest });
  if (first.type !== 'invoice' || second.type !== 'invoice') throw new Error('expected invoice responses');
  expect(second.invoice).toEqual(first.invoice);
});

test('changed payload under the same messageId is rejected as a tampered replay', async () => {
  const { application } = await harness();
  const first: BuyerRequest = {
    ...header({ messageId: 'msg-fixed-2' }), type: 'create', requestId: 'req-tamper', productVersion: 'book-v1', expectedAmountZat: '100',
  };
  await application.handle({ signerKeyId: 'buyer-1', body: first });
  const tampered: BuyerRequest = { ...first, requestId: 'req-different' };
  const response = await application.handle({ signerKeyId: 'buyer-1', body: tampered });
  expect(response.type).toBe('error');
});

test('status and recover requests from a signer who does not own the order are rejected as forbidden, not disclosed', async () => {
  const { application, scanner } = await harness();
  const createRequest: BuyerRequest = {
    ...header(), type: 'create', requestId: 'req-owner', productVersion: 'book-v1', expectedAmountZat: '100',
  };
  const created = await application.handle({ signerKeyId: 'buyer-owner', body: createRequest });
  if (created.type !== 'invoice') throw new Error('expected invoice');
  payInvoice(scanner, created.invoice);

  const statusRequest: BuyerRequest = { ...header(), type: 'status', orderId: created.invoice.orderId };
  const wrongStatus = await application.handle({ signerKeyId: 'attacker', body: statusRequest });
  expect(wrongStatus.type).toBe('error');
  if (wrongStatus.type === 'error') expect(wrongStatus.code).toBe('forbidden');

  const recoverRequest: BuyerRequest = { ...header(), type: 'recover', orderId: created.invoice.orderId };
  const wrongRecover = await application.handle({ signerKeyId: 'attacker', body: recoverRequest });
  expect(wrongRecover.type).toBe('error');
  if (wrongRecover.type === 'error') expect(wrongRecover.code).toBe('forbidden');

  const ownStatus = await application.handle({ signerKeyId: 'buyer-owner', body: statusRequest });
  expect(ownStatus.type).toBe('status');
});

test('recover discloses the sealed package only once eligible, then acknowledge binds to the exact packageId', async () => {
  const { application, scanner } = await harness();
  const createRequest: BuyerRequest = {
    ...header(), type: 'create', requestId: 'req-recover', productVersion: 'book-v1', expectedAmountZat: '100',
  };
  const created = await application.handle({ signerKeyId: 'buyer-recover', body: createRequest });
  if (created.type !== 'invoice') throw new Error('expected invoice');

  const recoverRequest: BuyerRequest = { ...header(), type: 'recover', orderId: created.invoice.orderId };
  const notEligible = await application.handle({ signerKeyId: 'buyer-recover', body: recoverRequest });
  expect(notEligible.type).toBe('error');
  if (notEligible.type === 'error') expect(notEligible.code).toBe('not_eligible');

  payInvoice(scanner, created.invoice);
  const recovered = await application.handle({
    signerKeyId: 'buyer-recover', body: { ...header({ messageId: 'msg-recover-2' }), type: 'recover', orderId: created.invoice.orderId },
  });
  expect(recovered.type).toBe('delivery');
  if (recovered.type !== 'delivery') throw new Error('unreachable');
  expect(recovered.package.orderId).toBe(created.invoice.orderId);
  expect(recovered.packageId).toBeTruthy();

  const ackRequest: BuyerRequest = { ...header(), type: 'acknowledge', orderId: created.invoice.orderId, packageId: 'wrong-package-id' };
  const wrongAck = await application.handle({ signerKeyId: 'buyer-recover', body: ackRequest });
  expect(wrongAck.type).toBe('error');

  const correctAck: BuyerRequest = { ...header(), type: 'acknowledge', orderId: created.invoice.orderId, packageId: recovered.packageId };
  const ackResponse = await application.handle({ signerKeyId: 'buyer-recover', body: correctAck });
  expect(ackResponse.type).toBe('acknowledged');
});

test('missing signer binding is impossible at this layer: response is always addressed to the caller-supplied signerKeyId, never a request-embedded key', async () => {
  const { application } = await harness();
  const createRequest: BuyerRequest = {
    ...header(), type: 'create', requestId: 'req-no-embedded-key', productVersion: 'book-v1', expectedAmountZat: '100',
  };
  const response = await application.handle({ signerKeyId: 'buyer-from-signature', body: createRequest });
  expect(response.buyerKeyId).toBe('buyer-from-signature');
});

test('expired request is rejected', async () => {
  const { application } = await harness();
  const expired: BuyerRequest = {
    ...header({ issuedAt: now() - 120_000, expiresAt: now() - 60_000 }), type: 'create', requestId: 'req-expired', productVersion: 'book-v1', expectedAmountZat: '100',
  };
  const response = await application.handle({ signerKeyId: 'buyer-1', body: expired });
  expect(response.type).toBe('error');
});

test('future-issued request is rejected', async () => {
  const { application } = await harness();
  const future: BuyerRequest = {
    ...header({ issuedAt: now() + 120_000, expiresAt: now() + 180_000 }), type: 'create', requestId: 'req-future', productVersion: 'book-v1', expectedAmountZat: '100',
  };
  const response = await application.handle({ signerKeyId: 'buyer-1', body: future });
  expect(response.type).toBe('error');
});

test('wrong seller key in the request is rejected rather than silently answered', async () => {
  const { application } = await harness();
  const wrongSeller: BuyerRequest = {
    ...header({ sellerKeyId: 'someone-elses-seller-key' }), type: 'create', requestId: 'req-wrong-seller', productVersion: 'book-v1', expectedAmountZat: '100',
  };
  const response = await application.handle({ signerKeyId: 'buyer-1', body: wrongSeller });
  expect(response.type).toBe('error');
});

test('wrong network in the request is rejected', async () => {
  const { application } = await harness();
  const wrongNetwork: BuyerRequest = {
    ...header({ network: 'test' }), type: 'create', requestId: 'req-wrong-network', productVersion: 'book-v1', expectedAmountZat: '100',
  };
  const response = await application.handle({ signerKeyId: 'buyer-1', body: wrongNetwork });
  expect(response.type).toBe('error');
});

test('every response correlates to the request that produced it via inReplyTo', async () => {
  const { application, scanner } = await harness();
  const createRequest: BuyerRequest = {
    ...header(), type: 'create', requestId: 'req-correlate', productVersion: 'book-v1', expectedAmountZat: '100',
  };
  const created = await application.handle({ signerKeyId: 'buyer-correlate', body: createRequest });
  if (created.type !== 'invoice') throw new Error('expected invoice');
  expect(created.inReplyTo).toBe(createRequest.messageId);

  payInvoice(scanner, created.invoice);
  const statusRequest: BuyerRequest = { ...header(), type: 'status', orderId: created.invoice.orderId };
  const statusResponse = await application.handle({ signerKeyId: 'buyer-correlate', body: statusRequest });
  expect(statusResponse.inReplyTo).toBe(statusRequest.messageId);
});

test('attachSellerApplication dispatches decoded Waku requests and replies to the verified signer over the same session', async () => {
  const { application } = await harness();
  const received: Array<{ recipientKeyId: string; body: unknown }> = [];
  let handler: ((message: { signerKeyId: string; body: BuyerRequest; wireEnvelope: Uint8Array }) => Promise<void>) | null = null;
  const fakeSession = {
    async ready() { return true; },
    async send(recipientKeyId: string, body: unknown) { received.push({ recipientKeyId, body }); },
    async subscribe(callback: typeof handler) {
      handler = callback;
      return async () => { handler = null; };
    },
    async decodeStored() { throw new Error('not used'); },
    async close() { handler = null; },
  };
  await attachSellerApplication(fakeSession as never, application);
  expect(handler).not.toBeNull();

  const createRequest: BuyerRequest = {
    ...header(), type: 'create', requestId: 'req-waku-dispatch', productVersion: 'book-v1', expectedAmountZat: '100',
  };
  await handler!({ signerKeyId: 'buyer-waku', body: createRequest, wireEnvelope: new Uint8Array() });

  expect(received).toHaveLength(1);
  expect(received[0]!.recipientKeyId).toBe('buyer-waku');
  const responseBody = received[0]!.body as { type: string; inReplyTo: string; buyerKeyId: string };
  expect(responseBody.type).toBe('invoice');
  expect(responseBody.inReplyTo).toBe(createRequest.messageId);
  expect(responseBody.buyerKeyId).toBe('buyer-waku');
});

test('attachSellerApplication ignores decoded SellerResponse bodies looping back to the seller\'s own decoder', async () => {
  const { application } = await harness();
  const received: unknown[] = [];
  let handler: ((message: { signerKeyId: string; body: unknown; wireEnvelope: Uint8Array }) => Promise<void>) | null = null;
  const fakeSession = {
    async ready() { return true; },
    async send(_recipientKeyId: string, body: unknown) { received.push(body); },
    async subscribe(callback: typeof handler) {
      handler = callback;
      return async () => { handler = null; };
    },
    async decodeStored() { throw new Error('not used'); },
    async close() { handler = null; },
  };
  await attachSellerApplication(fakeSession as never, application);
  const loopedResponse = {
    version: 1, messageId: 'resp-1', inReplyTo: 'msg-1', sellerKeyId: SELLER_KEY_ID, buyerKeyId: 'buyer-x',
    network: chain.network, issuedAt: now(), expiresAt: now() + 1000, type: 'acknowledged', orderId: 'order-x', packageId: 'pkg-x',
  };
  await handler!({ signerKeyId: 'buyer-x', body: loopedResponse, wireEnvelope: new Uint8Array() });
  expect(received).toHaveLength(0);
});

// --- Fix round 1 (Critical #1): a scanner outage never escapes the Waku handler.
function failScanner(scanner: MemoryScanner): void {
  scanner.snapshot = async () => { throw new WalletScannerUnavailableError(); };
}

test('status during a scanner outage still replies with a status whose verification is unavailable', async () => {
  const { application, scanner } = await harness();
  const created = await application.handle({ signerKeyId: 'buyer-1', body: {
    ...header(), type: 'create', requestId: 'req-outage-status', productVersion: 'book-v1', expectedAmountZat: '100',
  } });
  if (created.type !== 'invoice') throw new Error('expected invoice');
  failScanner(scanner);
  const response = await application.handle({ signerKeyId: 'buyer-1', body: { ...header(), type: 'status', orderId: created.invoice.orderId } });
  expect(response.type).toBe('status');
  if (response.type === 'status') expect(response.status.verification).toBe('unavailable');
});

test('recover during a scanner outage replies unavailable instead of throwing', async () => {
  const { application, scanner } = await harness();
  const created = await application.handle({ signerKeyId: 'buyer-1', body: {
    ...header(), type: 'create', requestId: 'req-outage-recover', productVersion: 'book-v1', expectedAmountZat: '100',
  } });
  if (created.type !== 'invoice') throw new Error('expected invoice');
  failScanner(scanner);
  const response = await application.handle({ signerKeyId: 'buyer-1', body: { ...header(), type: 'recover', orderId: created.invoice.orderId } });
  expect(response).toMatchObject({ type: 'error', code: 'unavailable' });
});

test('attachSellerApplication never lets a handler failure escape: sanitized log plus unavailable reply', async () => {
  const received: Array<{ recipientKeyId: string; body: unknown }> = [];
  let handler: ((message: { signerKeyId: string; body: BuyerRequest; wireEnvelope: Uint8Array }) => Promise<void>) | null = null;
  const fakeSession = {
    async ready() { return true; },
    async send(recipientKeyId: string, body: unknown) { received.push({ recipientKeyId, body }); },
    async subscribe(callback: typeof handler) { handler = callback; return async () => { handler = null; }; },
    async decodeStored() { throw new Error('not used'); },
    async close() { handler = null; },
  };
  const secret = 'secret-socket-path-/run/x.sock';
  const exploding = { async handle() { throw new Error(secret); } };
  const logger = createOperationalLogger(() => undefined);
  await attachSellerApplication(fakeSession as never, exploding, { logger, now });
  const request: BuyerRequest = { ...header({ messageId: 'msg-explode' }), type: 'status', orderId: 'order-x' };
  await expect(handler!({ signerKeyId: 'buyer-x', body: request, wireEnvelope: new Uint8Array() })).resolves.toBeUndefined();
  expect(received).toHaveLength(1);
  expect(received[0]!.body).toMatchObject({ type: 'error', code: 'unavailable', inReplyTo: 'msg-explode', buyerKeyId: 'buyer-x' });
  const lines = logger.lines();
  expect(lines.some((line) => /waku\.handler/.test(line))).toBe(true);
  for (const line of lines) expect(line).not.toContain(secret);
});
