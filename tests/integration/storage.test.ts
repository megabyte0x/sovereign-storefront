import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  FIRST_RELEASE_MAX_CIPHERTEXT_BYTES,
  FIRST_RELEASE_MAX_PLAINTEXT_BYTES,
  createCryptoAdapter,
} from '../../src/adapters/crypto.ts';
import { createCredentialAdapter } from '../../src/adapters/credentials.ts';
import {
  LOGOSCTL_VERSION,
  STORAGE_MODULE,
  STORAGE_MODULE_ROOT_HASH,
  STORAGE_MODULE_VERSION,
  createLogosStorageAdapter,
  detectLogosRuntime,
} from '../../src/adapters/storage.ts';
import { decryptDownload } from '../../src/browser/download.ts';
import { publishProduct } from '../../src/seller/admin.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();
const PLAINTEXT = new TextEncoder().encode('sovereign-storefront harmless fixture v1\n');

let scratchDir = '';
let catalogue: ReturnType<typeof openCatalogue> | undefined;

afterEach(() => {
  catalogue?.close();
  catalogue = undefined;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

test('pins logosctl 0.2.3 / storage_module 2.1.2 and first-release size', () => {
  expect(LOGOSCTL_VERSION).toBe('0.2.3');
  expect(STORAGE_MODULE).toBe('storage_module');
  expect(STORAGE_MODULE_VERSION).toBe('2.1.2');
  expect(STORAGE_MODULE_ROOT_HASH).toBe(
    '19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740',
  );
  expect(PLAINTEXT.byteLength).toBe(FIRST_RELEASE_MAX_PLAINTEXT_BYTES);
  expect(FIRST_RELEASE_MAX_CIPHERTEXT_BYTES).toBe(73);
});

test('live Logos origin upload uses completion, not fetch(); replica proof is not faked', async (ctx) => {
  const detected = detectLogosRuntime();
  if (!detected.ok) {
    ctx.skip();
    return;
  }

  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-storage-int-'));
  const storage = createLogosStorageAdapter(detected.runtime, scratchDir);
  const credentials = createCredentialAdapter();
  const buyer = await credentials.createPurchaseCredential();
  const crypto = createCryptoAdapter({ credentials });
  const { ciphertext, keyRef } = await crypto.encryptProduct(PLAINTEXT);
  expect(ciphertext.byteLength).toBe(FIRST_RELEASE_MAX_CIPHERTEXT_BYTES);

  const cid = await storage.publish(ciphertext);
  expect(cid.length).toBeGreaterThan(0);

  const replicaOk = await storage.verifyReplica(cid, detected.runtime.replicaConfigDir);
  if (!replicaOk) {
    ctx.skip();
    return;
  }
  expect(replicaOk).toBe(true);

  const dbPath = join(scratchDir, 'seller.sqlite');
  catalogue = openCatalogue({ dbPath, storage });
  const published = await publishProduct({
    dbPath,
    version: 'fixture-v1',
    description: 'Harmless fixture',
    amountZat: '100000000',
    network: 'test',
    plaintext: PLAINTEXT,
    crypto,
    storage,
    replicaId: detected.runtime.replicaConfigDir,
  });
  const fetched = await catalogue.getPublishedCiphertext('fixture-v1');
  expect(fetched.byteLength).toBe(FIRST_RELEASE_MAX_CIPHERTEXT_BYTES);
  const sealed = await crypto.sealDelivery({
    orderId: 'live-order',
    productVersion: 'fixture-v1',
    buyerKeyId: buyer.buyerKeyId,
    productKeyRef: published.sellerKeyRef as string,
  });
  const blob = await decryptDownload({
    orderId: 'live-order',
    productVersion: 'fixture-v1',
    buyerKeyId: buyer.buyerKeyId,
    encryptedEnvelope: sealed,
  }, fetched, { crypto, credentialId: buyer.credentialId });
  expect(blob.type).toBe('application/octet-stream');
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PLAINTEXT);
  expect(keyRef.length).toBeGreaterThan(0);
}, 360_000);
