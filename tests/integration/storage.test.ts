import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, type TestContext } from 'vitest';
import {
  DecryptionFailed,
  FIRST_RELEASE_MAX_CIPHERTEXT_BYTES,
  FIRST_RELEASE_MAX_PLAINTEXT_BYTES,
  PayloadTooLarge,
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
  type LogosRuntime,
} from '../../src/adapters/storage.ts';
import type { StorageAdapter } from '../../src/contracts/types.ts';
import { decryptDownload } from '../../src/browser/download.ts';
import { publishProduct } from '../../src/seller/admin.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();
const STRICT = process.env.SSF_STRICT_LIVE === '1';
const LIVE_TIMEOUT_MS = 360_000;

let scratchDir = '';
let catalogue: ReturnType<typeof openCatalogue> | undefined;

afterEach(() => {
  catalogue?.close();
  catalogue = undefined;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = '';
});

/**
 * A missing live precondition never passes by early return: under
 * SSF_STRICT_LIVE=1 it FAILS with the reason, otherwise it SKIPs with it.
 */
function unmet(ctx: TestContext, reason: string): never {
  if (STRICT) throw new Error(`SSF_STRICT_LIVE=1: ${reason}`);
  ctx.skip(reason);
  throw new Error(`unreachable after skip: ${reason}`);
}

function requireLive(ctx: TestContext): LogosRuntime {
  const detected = detectLogosRuntime();
  if (!detected.ok) unmet(ctx, `live Logos runtime unavailable: ${detected.reason}`);
  return detected.runtime;
}

function scratch(): string {
  if (!scratchDir) scratchDir = mkdtempSync(join(scratchRoot, 'ssf-storage-int-'));
  return scratchDir;
}

function liveStorage(runtime: LogosRuntime, maxBytes?: number): StorageAdapter {
  const workDir = mkdtempSync(join(scratch(), 'w-'));
  return createLogosStorageAdapter(runtime, { workDir }, maxBytes === undefined ? {} : { maxBytes });
}

async function requireReplica(ctx: TestContext, storage: StorageAdapter, cid: string, runtime: LogosRuntime) {
  const ok = await storage.verifyReplica(cid, runtime.replicaConfigDir);
  if (ok !== true) unmet(ctx, `replica B could not verify cid ${cid}`);
}

/** Fresh random payload per run (never the fixed fixture); 41 bytes by default. */
function freshPayload(bytes = FIRST_RELEASE_MAX_PLAINTEXT_BYTES): Uint8Array {
  return new Uint8Array(randomBytes(bytes));
}

function freshVersion(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

test('pins logosctl 0.2.3 / storage_module 2.1.2 and first-release size', () => {
  expect(LOGOSCTL_VERSION).toBe('0.2.3');
  expect(STORAGE_MODULE).toBe('storage_module');
  expect(STORAGE_MODULE_VERSION).toBe('2.1.2');
  expect(STORAGE_MODULE_ROOT_HASH).toBe(
    '19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740',
  );
  expect(FIRST_RELEASE_MAX_PLAINTEXT_BYTES).toBe(41);
  expect(FIRST_RELEASE_MAX_CIPHERTEXT_BYTES).toBe(73);
});

test('live Logos origin upload uses completion, not fetch(); replica proof is not faked', async (ctx) => {
  const runtime = requireLive(ctx);
  const plaintext = freshPayload();
  const storage = liveStorage(runtime);
  const credentials = createCredentialAdapter();
  const buyer = await credentials.createPurchaseCredential();
  const crypto = createCryptoAdapter({ credentials });
  const { ciphertext, keyRef } = await crypto.encryptProduct(plaintext);
  expect(ciphertext.byteLength).toBe(FIRST_RELEASE_MAX_CIPHERTEXT_BYTES);

  const cid = await storage.publish(ciphertext);
  expect(cid.length).toBeGreaterThan(0);
  await requireReplica(ctx, storage, cid, runtime);

  const dbPath = join(scratch(), 'seller.sqlite');
  const version = freshVersion('live');
  const published = await publishProduct({
    dbPath,
    version,
    description: 'Harmless live payload',
    amountZat: '100000000',
    network: 'test',
    plaintext,
    crypto,
    storage,
    replicaId: runtime.replicaConfigDir,
  });
  catalogue = openCatalogue({ dbPath, storage });
  const fetched = await catalogue.getPublishedCiphertext(version);
  expect(fetched.byteLength).toBe(FIRST_RELEASE_MAX_CIPHERTEXT_BYTES);
  const sealed = await crypto.sealDelivery({
    orderId: 'live-order',
    productVersion: version,
    buyerKeyId: buyer.buyerKeyId,
    productKeyRef: published.sellerKeyRef as string,
  });
  const blob = await decryptDownload({
    orderId: 'live-order',
    productVersion: version,
    buyerKeyId: buyer.buyerKeyId,
    encryptedEnvelope: sealed,
  }, fetched, { crypto, credentialId: buyer.credentialId });
  expect(blob.type).toBe('application/octet-stream');
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(plaintext);
  expect(keyRef.length).toBeGreaterThan(0);
}, LIVE_TIMEOUT_MS);

test('live: a 42-byte plaintext is rejected before any upload', async (ctx) => {
  const runtime = requireLive(ctx);
  const inner = liveStorage(runtime);
  let uploads = 0;
  const storage: StorageAdapter = {
    publish: (c) => { uploads += 1; return inner.publish(c); },
    fetch: (cid) => inner.fetch(cid),
    verifyReplica: (cid, id) => inner.verifyReplica(cid, id),
  };
  const credentials = createCredentialAdapter();
  const crypto = createCryptoAdapter({ credentials });
  const oversize = freshPayload(FIRST_RELEASE_MAX_PLAINTEXT_BYTES + 1);
  expect(oversize.byteLength).toBe(42);

  await expect(crypto.encryptProduct(oversize)).rejects.toBeInstanceOf(PayloadTooLarge);
  await expect(publishProduct({
    dbPath: join(scratch(), 'seller.sqlite'),
    version: freshVersion('oversize'),
    description: 'must not upload',
    amountZat: '100000000',
    network: 'test',
    plaintext: oversize,
    crypto,
    storage,
    replicaId: runtime.replicaConfigDir,
  })).rejects.toBeInstanceOf(PayloadTooLarge);
  expect(uploads).toBe(0);
}, LIVE_TIMEOUT_MS);

test('live: a one-byte-flipped ciphertext on a new CID is rejected by the catalogue digest check and by decryptDownload', async (ctx) => {
  const runtime = requireLive(ctx);
  const plaintext = freshPayload();
  const storage = liveStorage(runtime);
  const credentials = createCredentialAdapter();
  const buyer = await credentials.createPurchaseCredential();
  const crypto = createCryptoAdapter({ credentials });
  const dbPath = join(scratch(), 'seller.sqlite');
  const version = freshVersion('tamper');
  const published = await publishProduct({
    dbPath,
    version,
    description: 'Harmless live payload',
    amountZat: '100000000',
    network: 'test',
    plaintext,
    crypto,
    storage,
    replicaId: runtime.replicaConfigDir,
  });
  const goodCid = published.ciphertextCid as string;
  const original = await storage.fetch(goodCid);
  expect(original.byteLength).toBe(FIRST_RELEASE_MAX_CIPHERTEXT_BYTES);

  const tampered = new Uint8Array(original);
  tampered[20 + (randomBytes(1)[0] % 40)] ^= 0x01;
  const tamperedCid = await storage.publish(tampered);
  expect(tamperedCid).not.toBe(goodCid);
  await requireReplica(ctx, storage, tamperedCid, runtime);
  const tamperedFromB = await storage.fetch(tamperedCid);
  expect(tamperedFromB).toEqual(tampered);

  // Point the published row at the tampered CID; its stored digest stays the original's.
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('UPDATE products SET ciphertext_cid = ? WHERE version = ?').run(tamperedCid, version);
  } finally {
    db.close();
  }
  catalogue = openCatalogue({ dbPath, storage });
  await expect(catalogue.getPublishedCiphertext(version)).rejects.toThrow(/digest mismatch/);

  const sealed = await crypto.sealDelivery({
    orderId: 'tamper-order',
    productVersion: version,
    buyerKeyId: buyer.buyerKeyId,
    productKeyRef: published.sellerKeyRef as string,
  });
  const pkg = {
    orderId: 'tamper-order',
    productVersion: version,
    buyerKeyId: buyer.buyerKeyId,
    encryptedEnvelope: sealed,
  };
  // decryptDownload checks the manifest (sha256 digest of the ciphertext) before
  // AES-GCM, so a single flipped byte fails integrity as DecryptionFailed('manifest mismatch').
  const tamperErr = await decryptDownload(pkg, tamperedFromB, { crypto, credentialId: buyer.credentialId })
    .then(() => undefined, (e: unknown) => e);
  expect(tamperErr).toBeInstanceOf(DecryptionFailed);
  expect((tamperErr as DecryptionFailed).message).toBe('manifest mismatch');
  expect((tamperErr as DecryptionFailed).plaintextExposed).toBe(false);
  // Control: the untampered bytes from B still decrypt to the exact payload.
  const ok = await decryptDownload(pkg, original, { crypto, credentialId: buyer.credentialId });
  expect(new Uint8Array(await ok.arrayBuffer())).toEqual(plaintext);
}, LIVE_TIMEOUT_MS);

test('live: a 74-byte ciphertext is rejected by maxBytes on publish and on replica download', async (ctx) => {
  const runtime = requireLive(ctx);
  const storage = liveStorage(runtime);
  const oversize = new Uint8Array(randomBytes(FIRST_RELEASE_MAX_CIPHERTEXT_BYTES + 1));
  expect(oversize.byteLength).toBe(74);
  await expect(storage.publish(oversize)).rejects.toBeInstanceOf(PayloadTooLarge);

  // Put the 74 bytes on the network through a looser adapter, then prove the
  // default (73-byte) adapter refuses them when reading from replica B.
  const loose = liveStorage(runtime, FIRST_RELEASE_MAX_CIPHERTEXT_BYTES + 1);
  const cid = await loose.publish(oversize);
  await requireReplica(ctx, loose, cid, runtime);
  await expect(storage.fetch(cid)).rejects.toBeInstanceOf(PayloadTooLarge);
  expect(await storage.verifyReplica(cid, runtime.replicaConfigDir)).toBe(false);
}, LIVE_TIMEOUT_MS);
