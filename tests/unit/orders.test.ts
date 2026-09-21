import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openStore } from '../../src/seller/db.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();

let dbPath = '';
let scratchDir = '';
let store: Awaited<ReturnType<typeof openStore>>;

beforeEach(() => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-orders-'));
  dbPath = join(scratchDir, 'seller.sqlite');
});

afterEach(async () => {
  await store?.close().catch(() => undefined);
  rmSync(scratchDir, { recursive: true, force: true });
});

test('createOrder is idempotent for the same buyer request and rejects changed terms', async () => {
  store = await openStore(dbPath);
  const input = {requestId: 'retry-1', buyerKeyId: 'buyer-a', productVersion: 'book-v1'};
  const first = await store.createOrder(input);
  await store.close();
  store = await openStore(dbPath);
  expect((await store.createOrder(input)).id).toBe(first.id);
  await expect(store.createOrder({...input, productVersion: 'other-v1'})).rejects.toThrow();
});
