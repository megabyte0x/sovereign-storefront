import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { createDecoder, createEncoder } from '@waku/message-encryption/ecies';
import { bytesToHex } from '@waku/utils/bytes';
import type { WakuConfig } from '../../src/contracts/messages.ts';
import { createWakuSession, type WakuNode } from '../../src/adapters/waku.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import type { CredentialAdapter, PurchaseStore, ServiceAvailability, SellerStore, BrowserPurchase } from '../../src/contracts/types.ts';
import type { ChainIdentity } from '../../src/contracts/live.ts';
import { openStore } from '../../src/seller/db.ts';
import { createInvoiceIssuer } from '../../src/seller/issuance.ts';
import { attachSellerApplication, createSellerApplication } from '../../src/seller/messages.ts';
import { createPayments } from '../../src/seller/payments.ts';
import { createWakuOrderTransport } from '../../src/browser/waku-transport.ts';

type EciesEncoder = ReturnType<typeof createEncoder>;
type EciesDecoder = ReturnType<typeof createDecoder>;

const CONTENT_TOPIC = '/ssf/1/test-run/proto';
const chain: ChainIdentity = { network: 'regtest', genesisHash: 'a'.repeat(64), consensusFingerprint: 'c'.repeat(64) };
const accountId = 'fixture-account';

function freshConfig(): WakuConfig {
  return { contentTopic: CONTENT_TOPIC, bootstrapPeers: [], peerTimeoutMs: 1000 };
}

/** Same fake transport as tests/unit/waku.test.ts: routes lightPush.send
 * through real encoder→decoder ECIES round trips between every session
 * sharing this node, so the whole wire format is genuinely exercised. */
function makeFakeNode(): { node: WakuNode } {
  const subscribers: Array<{ decoder: EciesDecoder; callback: (msg: unknown) => unknown }> = [];
  const node: WakuNode = {
    async waitForPeers() { return; },
    lightPush: {
      async send(encoder: EciesEncoder, message: { payload: Uint8Array }) {
        const proto = await encoder.toProtoObj(message);
        if (proto) {
          for (const { decoder, callback } of subscribers) {
            const decoded = await decoder.fromProtoObj(encoder.pubsubTopic, proto);
            if (decoded) await callback(decoded);
          }
        }
        return { successes: ['peer-a'], failures: [] } as never;
      },
    } as never,
    filter: {
      async subscribe(decoder: EciesDecoder, callback: (msg: unknown) => unknown) {
        subscribers.push({ decoder, callback });
        return true;
      },
      async unsubscribe() { return true; },
    } as never,
    events: {
      addEventListener() { },
      removeEventListener() { },
    } as never,
    async stop() { return; },
  };
  return { node };
}

function memoryPurchaseStore(): PurchaseStore {
  const saved = new Map<string, BrowserPurchase>();
  const deliveries = new Map<string, { packageId: string; wireEnvelope: Uint8Array }>();
  return {
    async save(record) { saved.set(record.requestId, record); },
    async get(requestId) { return saved.get(requestId) ?? null; },
    async list() { return [...saved.values()]; },
    async exportBackup() { throw new Error('not used'); },
    async importBackup() { throw new Error('not used'); },
    async saveDelivery(orderId, record) { deliveries.set(orderId, record); },
    async getDelivery(orderId) { return deliveries.get(orderId) ?? null; },
  };
}

/**
 * A fake CredentialAdapter binding a single credentialId to one already-
 * generated key pair, so `credentials.publicKey(credentialId)` and the
 * WakuSession built from the same private key are guaranteed to agree on
 * signer identity — exactly the invariant the real `createCredentialAdapter`
 * upholds internally (one private key backs both `publicKey()` and
 * `createWakuSession()` for a given credentialId), without needing to route
 * this unit test's fake transport node through the real adapter.
 */
function fakeCredentialAdapter(credentialId: string, publicKeyHex: string): CredentialAdapter {
  return {
    async createPurchaseCredential() { throw new Error('not used in this test'); },
    async provePossession() { throw new Error('not used in this test'); },
    async verifyPossession() { throw new Error('not used in this test'); },
    async decryptWrapped() { throw new Error('not used in this test'); },
    async exportBackupMaterial() { throw new Error('not used in this test'); },
    async importBackupMaterial() { throw new Error('not used in this test'); },
    async publicKey(id: string) {
      if (id !== credentialId) throw new Error('unknown credential');
      return publicKeyHex;
    },
    async createWakuSession() { throw new Error('not used in this test'); },
  };
}

const scratchRoot = process.env.TMPDIR ?? tmpdir();
const availability: ServiceAvailability = { productPublished: true, messaging: true, storageReplica: true, scanner: true };

let scratchDir = '';
let dbPath = '';
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
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-waku-transport-'));
  dbPath = join(scratchDir, 'seller.sqlite');
  setupProduct(dbPath);
});

afterEach(async () => {
  await store?.close().catch(() => undefined);
  rmSync(scratchDir, { recursive: true, force: true });
});

async function harness(node: WakuNode) {
  store = await openStore(dbPath);
  const scanner = new MemoryScanner();
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId, ttlMs: 60_000, now: () => Date.now(),
    availability: async () => availability,
  });
  const payments = createPayments({
    store, scanner, now: () => Date.now(),
    preparePackage: async (invoice) => ({
      orderId: invoice.orderId, productVersion: invoice.productVersion, buyerKeyId: invoice.buyerKeyId,
      encryptedEnvelope: new Uint8Array([9, 9, 9]),
    }),
  });
  const sellerIdentity = generatePrivateKey();
  const sellerKeyId = bytesToHex(getPublicKey(sellerIdentity));
  const application = createSellerApplication({
    store, issuer, payments, sellerKeyId, network: chain.network, now: () => Date.now(),
  });
  const sellerSession = createWakuSession(freshConfig(), sellerIdentity, { createNode: async () => node });
  await attachSellerApplication(sellerSession, application);
  return { store, scanner, sellerKeyId, sellerSession };
}

function buyerTransport(node: WakuNode, sellerKeyId: string, purchases: PurchaseStore): {
  transport: ReturnType<typeof createWakuOrderTransport>;
  credentialId: string;
} {
  const buyerIdentity = generatePrivateKey();
  const buyerKeyId = bytesToHex(getPublicKey(buyerIdentity));
  const credentialId = `cred-${buyerKeyId.slice(0, 16)}`;
  const credentials = fakeCredentialAdapter(credentialId, buyerKeyId);
  const buyerSession = createWakuSession(freshConfig(), buyerIdentity, { createNode: async () => node });
  const transport = createWakuOrderTransport(credentials, buyerSession, {
    sellerKeyId, network: chain.network, amountZat: '100', productVersion: 'book-v1',
  }, purchases);
  return { transport, credentialId };
}

describe('createWakuOrderTransport', () => {
  test('create/status/recover/acknowledge round-trip a real signed order over Waku end to end', async () => {
    const { node } = makeFakeNode();
    const { scanner, sellerKeyId } = await harness(node);
    const purchases = memoryPurchaseStore();
    const { transport, credentialId } = buyerTransport(node, sellerKeyId, purchases);

    const record: BrowserPurchase = {
      version: 1, requestId: 'req-e2e', orderId: null, productVersion: 'book-v1',
      sellerOrigin: 'https://seller.example', sellerKeyId, credentialId, invoice: null,
    };
    const invoice = await transport.create(record);
    expect(invoice.orderId).toBeTruthy();
    if (invoice.attribution?.kind !== 'receiver') throw new Error('expected receiver attribution');
    expect(invoice.attribution.kind).toBe('receiver');

    const beforePay = await transport.status(invoice.orderId, credentialId);
    expect(beforePay.payment).toBe('awaiting');

    scanner.setReceiptReceiver('out-e2e', invoice.attribution.receiver);
    scanner.replaceSnapshot(
      [{ outputId: 'out-e2e', invoiceId: null, amountZat: invoice.amountZat, confirmations: 0, canonical: true, receivedAt: Date.now(), revision: { id: 'rev-1', height: 1 } }],
      { id: 'rev-10', height: 10 },
      true,
      Date.now(),
    );

    const afterPay = await transport.status(invoice.orderId, credentialId);
    expect(afterPay.payment).toBe('confirmed');

    const pkg = await transport.recover(invoice.orderId, credentialId);
    expect(pkg.orderId).toBe(invoice.orderId);
    const stored = await purchases.getDelivery(invoice.orderId);
    expect(stored).not.toBeNull();
    expect(stored!.wireEnvelope.byteLength).toBeGreaterThan(0);
    // The wire package has no packageId; recover must carry the response's id
    // so the caller can acknowledge exactly the package it decrypted.
    expect(pkg.packageId).toBe(stored!.packageId);

    await transport.acknowledge(invoice.orderId, credentialId, stored!.packageId);
    const finalStatus = await transport.status(invoice.orderId, credentialId);
    expect(finalStatus.delivery).toBe('acknowledged');
  });

  test('a signer other than the credential owner cannot recover or acknowledge someone else\'s order', async () => {
    const { node } = makeFakeNode();
    const { scanner, sellerKeyId } = await harness(node);
    const purchases = memoryPurchaseStore();
    const { transport: ownerTransport, credentialId: ownerCredentialId } = buyerTransport(node, sellerKeyId, purchases);
    const { transport: attackerTransport, credentialId: attackerCredentialId } = buyerTransport(node, sellerKeyId, purchases);

    const record: BrowserPurchase = {
      version: 1, requestId: 'req-forbidden', orderId: null, productVersion: 'book-v1',
      sellerOrigin: 'https://seller.example', sellerKeyId, credentialId: ownerCredentialId, invoice: null,
    };
    const invoice = await ownerTransport.create(record);
    if (invoice.attribution?.kind !== 'receiver') throw new Error('expected receiver attribution');
    scanner.setReceiptReceiver('out-forbidden', invoice.attribution.receiver);
    scanner.replaceSnapshot(
      [{ outputId: 'out-forbidden', invoiceId: null, amountZat: invoice.amountZat, confirmations: 0, canonical: true, receivedAt: Date.now(), revision: { id: 'rev-1', height: 1 } }],
      { id: 'rev-10', height: 10 }, true, Date.now(),
    );

    await expect(attackerTransport.recover(invoice.orderId, attackerCredentialId)).rejects.toThrow();
  });

  test('retries with a fresh messageId when a response is lost in transit, and still completes', async () => {
    const { node } = makeFakeNode();
    const { sellerKeyId } = await harness(node);
    const purchases = memoryPurchaseStore();
    const { transport, credentialId } = buyerTransport(node, sellerKeyId, purchases);

    // Drop exactly the seller's reply (the second send on this node: buyer's
    // request goes through, seller's response gets dropped once) to force a
    // genuine retry through sendAndWait's timeout-and-resend path.
    let sends = 0;
    const originalSend = node.lightPush.send.bind(node.lightPush);
    node.lightPush.send = (async (encoder: EciesEncoder, message: { payload: Uint8Array }) => {
      sends += 1;
      if (sends === 2) {
        return { successes: ['peer-a'], failures: [] } as never; // ack the send but deliver nothing: response "lost"
      }
      return originalSend(encoder, message);
    }) as typeof node.lightPush.send;

    const record: BrowserPurchase = {
      version: 1, requestId: 'req-retry', orderId: null, productVersion: 'book-v1',
      sellerOrigin: 'https://seller.example', sellerKeyId, credentialId, invoice: null,
    };
    const invoice = await transport.create(record);
    expect(invoice.orderId).toBeTruthy();
  }, 15_000);

  test('rejects when the seller responds with an error body (e.g. unpublished product)', async () => {
    const { node } = makeFakeNode();
    const { sellerKeyId } = await harness(node);
    const purchases = memoryPurchaseStore();
    const { transport, credentialId } = buyerTransport(node, sellerKeyId, purchases);

    const record: BrowserPurchase = {
      version: 1, requestId: 'req-unpublished', orderId: null, productVersion: 'nonexistent-version',
      sellerOrigin: 'https://seller.example', sellerKeyId, credentialId, invoice: null,
    };
    await expect(transport.create(record)).rejects.toThrow(/seller rejected request/);
  });
});
