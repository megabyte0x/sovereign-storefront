import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  FIRST_RELEASE_MAX_PLAINTEXT_BYTES,
  createCryptoAdapter,
  createManifestVerifier,
  decryptSsf1,
  importAesKey,
} from '../../src/adapters/crypto.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { decryptDownload } from '../../src/browser/download.ts';
import { createCredentialAdapter } from '../../src/adapters/credentials.ts';
import { allowNewCheckout } from '../../src/contracts/types.ts';
import { publishProduct } from '../../src/seller/admin.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { openStore } from '../../src/seller/db.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();
const FIXTURE_V1 = new TextEncoder().encode('sovereign-storefront harmless fixture v1\n');
const FIXTURE_V2 = new TextEncoder().encode('sovereign-storefront harmless fixture v2\n');

let scratchDir = '';
let dbPath = '';
let store: Awaited<ReturnType<typeof openStore>> | undefined;
let catalogue: ReturnType<typeof openCatalogue> | undefined;

const health = {
  messaging: true,
  storageReplica: true,
  scanner: true,
};

beforeEach(() => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-avail-'));
  dbPath = join(scratchDir, 'seller.sqlite');
  health.messaging = true;
  health.storageReplica = true;
  health.scanner = true;
});

afterEach(async () => {
  catalogue?.close();
  catalogue = undefined;
  await store?.close().catch(() => undefined);
  store = undefined;
  rmSync(scratchDir, { recursive: true, force: true });
});

function probes() {
  return {
    messaging: async () => health.messaging,
    storageReplica: async () => health.storageReplica,
    scanner: async () => health.scanner,
  };
}

test('failed publication does not create a purchasable listing', async () => {
  const storage = createMemoryStorageAdapter();
  storage.setReplica(false);
  const crypto = createCryptoAdapter();
  catalogue = openCatalogue({ dbPath, storage, probes: probes() });
  await expect(publishProduct({
    dbPath,
    version: 'book-v1',
    description: 'Book',
    amountZat: '100000000',
    network: 'test',
    plaintext: FIXTURE_V1,
    crypto,
    storage,
    replicaId: 'replica-b',
  })).rejects.toThrow();
  expect(catalogue.listPublished()).toEqual([]);
  await expect(catalogue.getPublishedCiphertext('book-v1')).rejects.toThrow();
  const availability = await catalogue.currentAvailability();
  expect(availability.productPublished).toBe(false);
  expect(allowNewCheckout(availability)).toBe(false);
});

test('successful publish then a down dependency blocks new checkout but not recovery', async () => {
  const storage = createMemoryStorageAdapter();
  const crypto = createCryptoAdapter();
  catalogue = openCatalogue({ dbPath, storage, probes: probes() });
  await publishProduct({
    dbPath,
    version: 'book-v1',
    description: 'Book',
    amountZat: '100000000',
    network: 'test',
    plaintext: FIXTURE_V1,
    crypto,
    storage,
    replicaId: 'replica-b',
  });
  const up = await catalogue.currentAvailability();
  expect(up).toEqual({
    productPublished: true,
    messaging: true,
    storageReplica: true,
    scanner: true,
  });
  expect(allowNewCheckout(up)).toBe(true);

  store = await openStore(dbPath);
  const order = await store.createOrder({
    requestId: 'paid-1',
    buyerKeyId: 'buyer-a',
    productVersion: 'book-v1',
  });
  const invoice = await store.getOrCreateInvoice({
    orderId: order.id,
    buyerKeyId: 'buyer-a',
    productVersion: 'book-v1',
    now: 1000,
    availability: up,
  });

  health.scanner = false;
  const down = await catalogue.currentAvailability();
  expect(down.scanner).toBe(false);
  expect(allowNewCheckout(down)).toBe(false);
  await expect(store.getOrCreateInvoice({
    orderId: (await store.createOrder({
      requestId: 'new-2',
      buyerKeyId: 'buyer-a',
      productVersion: 'book-v1',
    })).id,
    buyerKeyId: 'buyer-a',
    productVersion: 'book-v1',
    now: 1100,
    availability: down,
  })).rejects.toThrow(/checkout unavailable/);

  const recovered = await store.getOrCreateInvoice({
    orderId: order.id,
    buyerKeyId: 'buyer-a',
    productVersion: 'book-v1',
    now: 1200,
    availability: down,
  });
  expect(recovered).toEqual(invoice);
  const ciphertext = await catalogue.getPublishedCiphertext('book-v1');
  expect(ciphertext.byteLength).toBeLessThanOrEqual(73);
});

test('old product versions remain retrievable after price and content updates', async () => {
  const storage = createMemoryStorageAdapter();
  const crypto = createCryptoAdapter();
  catalogue = openCatalogue({ dbPath, storage, probes: probes() });
  const v1 = await publishProduct({
    dbPath,
    version: 'book-v1',
    description: 'Book',
    amountZat: '100000000',
    network: 'test',
    plaintext: FIXTURE_V1,
    crypto,
    storage,
    replicaId: 'replica-b',
  });
  const v2 = await publishProduct({
    dbPath,
    version: 'book-v2',
    description: 'Book revised',
    amountZat: '200000000',
    network: 'test',
    plaintext: FIXTURE_V2,
    crypto,
    storage,
    replicaId: 'replica-b',
  });
  expect(v1.amountZat).toBe('100000000');
  expect(v2.amountZat).toBe('200000000');
  const first = await catalogue.getPublishedCiphertext('book-v1');
  const second = await catalogue.getPublishedCiphertext('book-v2');
  expect(first).not.toEqual(second);
  expect(catalogue.listPublished().map((item) => item.version).sort()).toEqual(['book-v1', 'book-v2']);
});

test('deletion is refused while required references exist', async () => {
  const storage = createMemoryStorageAdapter();
  const crypto = createCryptoAdapter();
  catalogue = openCatalogue({ dbPath, storage, probes: probes() });
  await publishProduct({
    dbPath,
    version: 'book-v1',
    description: 'Book',
    amountZat: '100000000',
    network: 'test',
    plaintext: FIXTURE_V1,
    crypto,
    storage,
    replicaId: 'replica-b',
  });
  store = await openStore(dbPath);
  await store.createOrder({
    requestId: 'ref-1',
    buyerKeyId: 'buyer-a',
    productVersion: 'book-v1',
  });
  expect(() => catalogue!.deleteProduct('book-v1')).toThrow(/required references/);
  expect(catalogue.getManifest('book-v1')?.published).toBe(true);
});

test('decryptDownload rejects corruption before plaintext and returns an attachment blob', async () => {
  const credentials = createCredentialAdapter();
  const buyer = await credentials.createPurchaseCredential();
  const crypto = createCryptoAdapter({ credentials });
  const { ciphertext, keyRef } = await crypto.encryptProduct(FIXTURE_V1);
  const envelope = await crypto.sealDelivery({
    orderId: 'order-1',
    productVersion: 'book-v1',
    buyerKeyId: buyer.buyerKeyId,
    productKeyRef: keyRef,
  });
  const pkg = {
    orderId: 'order-1',
    productVersion: 'book-v1',
    buyerKeyId: buyer.buyerKeyId,
    encryptedEnvelope: envelope,
  };
  const access = { crypto, credentialId: buyer.credentialId };
  const corrupted = new Uint8Array(ciphertext);
  corrupted[corrupted.length - 1] ^= 0xff;
  await expect(decryptDownload(pkg, corrupted, access)).rejects.toMatchObject({
    name: 'DecryptionFailed',
    plaintextExposed: false,
  });

  const blob = await decryptDownload(pkg, ciphertext, access);
  expect(blob.type).toBe('application/octet-stream');
  expect(blob.type).not.toMatch(/html/i);
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(FIXTURE_V1);
  expect(createManifestVerifier()).toBeTruthy();
  const key = await importAesKey(await crypto.openDelivery(envelope, buyer.credentialId).then((o) => o.productKey));
  expect(await decryptSsf1(key, ciphertext)).toEqual(FIXTURE_V1);
});

test('publish rejects oversize plaintext before upload', async () => {
  const storage = createMemoryStorageAdapter();
  const crypto = createCryptoAdapter();
  catalogue = openCatalogue({ dbPath, storage, probes: probes() });
  const tooBig = new Uint8Array(FIRST_RELEASE_MAX_PLAINTEXT_BYTES + 1);
  await expect(publishProduct({
    dbPath,
    version: 'book-big',
    description: 'Too big',
    amountZat: '100000000',
    network: 'test',
    plaintext: tooBig,
    crypto,
    storage,
    replicaId: 'replica-b',
  })).rejects.toThrow();
  expect(catalogue.listPublished()).toEqual([]);
  expect(storage.uploaded).toEqual([]);
});

test('openDelivery fails for the wrong credentialId', async () => {
  const credentials = createCredentialAdapter();
  const buyer = await credentials.createPurchaseCredential();
  const other = await credentials.createPurchaseCredential();
  const crypto = createCryptoAdapter({ credentials });
  const { keyRef } = await crypto.encryptProduct(FIXTURE_V1);
  const envelope = await crypto.sealDelivery({
    orderId: 'order-1',
    productVersion: 'book-v1',
    buyerKeyId: buyer.buyerKeyId,
    productKeyRef: keyRef,
  });
  await expect(crypto.openDelivery(envelope, other.credentialId)).rejects.toMatchObject({
    name: 'DecryptionFailed',
    plaintextExposed: false,
  });
  const opened = await crypto.openDelivery(envelope, buyer.credentialId);
  expect(opened.productKey.byteLength).toBe(32);
});

test('per-product availability probes that product replica, not the first published one', async () => {
  const inner = createMemoryStorageAdapter();
  const crypto = createCryptoAdapter();
  let missingCid = '';
  const storage = {
    publish: (bytes: Uint8Array) => inner.publish(bytes),
    fetch: (cid: string) => inner.fetch(cid),
    verifyReplica: async (cid: string, replicaId: string) => cid !== missingCid && inner.verifyReplica(cid, replicaId),
  };
  const v1 = await publishProduct({
    dbPath, version: 'book-v1', description: 'Book', amountZat: '100000000', network: 'test',
    plaintext: FIXTURE_V1, crypto, storage, replicaId: 'replica-b',
  });
  const v2 = await publishProduct({
    dbPath, version: 'book-v2', description: 'Book 2', amountZat: '100000000', network: 'test',
    plaintext: FIXTURE_V2, crypto, storage, replicaId: 'replica-b',
  });
  missingCid = v2.ciphertextCid ?? '';
  expect(v1.ciphertextCid).not.toBe(v2.ciphertextCid);
  catalogue = openCatalogue({ dbPath, storage, probes: { messaging: probes().messaging, scanner: probes().scanner } });
  const first = await catalogue.productAvailability('book-v1');
  expect(first).toEqual({ productPublished: true, messaging: true, storageReplica: true, scanner: true });
  const second = await catalogue.productAvailability('book-v2');
  expect(second.productPublished).toBe(true);
  expect(second.storageReplica).toBe(false);
  expect(allowNewCheckout(second)).toBe(false);
  const unknown = await catalogue.productAvailability('book-v9');
  expect(unknown.productPublished).toBe(false);
  expect(unknown.storageReplica).toBe(false);
});
