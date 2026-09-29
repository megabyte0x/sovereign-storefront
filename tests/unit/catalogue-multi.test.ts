import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createCryptoAdapter } from '../../src/adapters/crypto.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { loadConfig } from '../../src/config.ts';
import { validateProductSummary, type ProductSummary } from '../../src/contracts/public.ts';
import { publishProduct } from '../../src/seller/admin.ts';
import { startSeller, type SellerServer } from '../../src/seller/server.ts';

const DESTINATION =
  'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

let scratch = '';
let seller: SellerServer | undefined;

afterEach(async () => {
  await seller?.close().catch(() => undefined);
  seller = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

function listedProducts(body: unknown): ProductSummary[] {
  if (!Array.isArray(body)) throw new Error('products response is not an array');
  return body.map((item) => validateProductSummary(item));
}

function versionOf(body: unknown): string {
  if (body === null || typeof body !== 'object' || !('version' in body) || typeof body.version !== 'string') {
    throw new Error('product response missing version');
  }
  return body.version;
}

test('published products list in creation order; drafts stay hidden; missing version 404s; checkout page is HTML', async () => {
  scratch = mkdtempSync(join(tmpdir(), 'ssf-catalogue-multi-'));
  const dbPath = join(scratch, 'seller.sqlite');
  const storage = createMemoryStorageAdapter();
  const crypto = createCryptoAdapter();
  const config = loadConfig({
    SSF_MODE: 'fixture',
    SSF_NETWORK: 'test',
    SSF_MIN_CONFIRMATIONS: '10',
    SSF_MAX_HEALTH_AGE_MS: '120000',
    SSF_MAX_CIPHERTEXT_BYTES: '73',
    SSF_MAX_PLAINTEXT_BYTES: '41',
    SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_HOST: '127.0.0.1',
    SSF_PUBLIC_PORT: '0',
    SSF_ADMIN_HOST: '127.0.0.1',
    SSF_ADMIN_PORT: '0',
    SSF_DB_PATH: dbPath,
    SSF_SELLER_KEY_ID: 'seller-key-1',
    SSF_DESTINATION: DESTINATION,
    SSF_ADAPTER_MESSAGING: 'fixture',
    SSF_ADAPTER_STORAGE: 'fixture',
    SSF_ADAPTER_SCANNER: 'fixture',
    SSF_ADMIN_TOKEN: 'admin-token-not-for-examples',
  });
  seller = await startSeller({
    config,
    seedProduct: false,
    storage,
    startLoops: false,
    replicaReady: (version) => version === 'v1',
  });
  const publish = (version: string, description: string) => publishProduct({
    dbPath,
    version,
    description,
    amountZat: '100000000',
    network: 'test',
    plaintext: new TextEncoder().encode(`fixture ${version}\n`),
    crypto,
    storage,
    replicaId: 'replica',
  });
  await publish('v1', 'First');
  seller.core.catalogue.beginPublication({
    version: 'draft',
    description: 'Not for sale',
    amountZat: '100000000',
    network: 'test',
  });
  await publish('v2', 'Second');

  const listed = await fetch(`${seller.publicUrl}/api/products`);
  expect(listed.status).toBe(200);
  const products = listedProducts(await listed.json());
  expect(products.map((item) => item.version)).toEqual(['v1', 'v2']);
  expect(products.map((item) => item.version)).not.toContain('draft');
  expect(products[0]).toMatchObject({ version: 'v1', available: true });
  expect(products[1]).toMatchObject({ version: 'v2', available: false });

  const missing = await fetch(`${seller.publicUrl}/api/products/nope`);
  expect(missing.status).toBe(404);

  const page = await fetch(`${seller.publicUrl}/p/v2`);
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toMatch(/text\/html/);
  expect(await page.text()).toMatch(/<html/i);

  const oldest = await fetch(`${seller.publicUrl}/api/product`);
  expect(oldest.status).toBe(200);
  expect(versionOf(await oldest.json())).toBe('v1');
});
