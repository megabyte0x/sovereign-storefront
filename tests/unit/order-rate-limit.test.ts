import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import type { SellerStore, ServiceAvailability } from '../../src/contracts/types.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { openStore } from '../../src/seller/db.ts';
import { createInvoiceIssuer } from '../../src/seller/issuance.ts';
import { IssuanceLimiter, RateLimitedError } from '../../src/seller/orders.ts';

const chain = { network: 'regtest' as const, genesisHash: 'a'.repeat(64), consensusFingerprint: 'c'.repeat(64) };
const accountId = 'fixture-account';
const available: ServiceAvailability = { productPublished: true, messaging: true, storageReplica: true, scanner: true };
const limits = { openInvoicesPerBuyer: 3, invoicesPerMinute: 30 };

let scratch = '';
let store: SellerStore | undefined;
let limiterDb: DatabaseSync | undefined;

afterEach(async () => {
  await store?.close().catch(() => undefined);
  limiterDb?.close();
  store = undefined;
  limiterDb = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

function setupProduct(dbPath: string): void {
  const catalogue = openCatalogue({ dbPath, storage: createMemoryStorageAdapter() });
  catalogue.beginPublication({ version: 'product-v1', description: 'fixture', amountZat: '100', network: chain.network });
  catalogue.completePublication({
    version: 'product-v1', ciphertextCid: 'fixture-cid', ciphertextDigest: 'a'.repeat(64), fileSize: 1,
    sellerKeyRef: 'fixture-key', wrappedKey: new Uint8Array([1]),
  });
  catalogue.close();
}

function harness(
  now: () => number,
  options: {
    limits?: { openInvoicesPerBuyer: number; invoicesPerMinute: number };
    onAllocate?: () => Promise<void>;
  } = {},
) {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-rate-'));
  const dbPath = join(scratch, 'seller.sqlite');
  setupProduct(dbPath);
  const scanner = new MemoryScanner();
  let allocations = 0;
  const allocate = scanner.allocateReceiver.bind(scanner);
  scanner.allocateReceiver = async (input) => {
    allocations += 1;
    await options.onAllocate?.();
    return allocate(input);
  };
  return openStore(dbPath).then((opened) => {
    store = opened;
    limiterDb = new DatabaseSync(dbPath);
    const limiter = new IssuanceLimiter({ db: limiterDb, config: { limits: options.limits ?? limits }, now });
    const issuer = createInvoiceIssuer({
      store: opened, scanner, chain, accountId, ttlMs: 1_000, now,
      availability: async () => available,
      limiter,
    });
    return { issuer, allocations: () => allocations };
  });
}

test('a 4th open invoice is rate_limited, but the same requestId still replays', async () => {
  const now = () => 1_000_000;
  const { issuer, allocations } = await harness(now);
  const buyerKeyId = 'buyer-open';
  const issued = [];
  for (let i = 1; i <= 3; i += 1) {
    issued.push(await issuer.issue({
      requestId: `req-${i}`, buyerKeyId, productVersion: 'product-v1', expectedAmountZat: '100',
    }));
  }
  await expect(issuer.issue({
    requestId: 'req-4', buyerKeyId, productVersion: 'product-v1', expectedAmountZat: '100',
  })).rejects.toBeInstanceOf(RateLimitedError);

  const replay = await issuer.issue({
    requestId: 'req-1', buyerKeyId, productVersion: 'product-v1', expectedAmountZat: '100',
  });
  expect(replay.id).toBe(issued[0]!.id);
  expect(allocations()).toBe(3);
});

test('the global per-minute cap refuses the 31st invoice', async () => {
  const now = () => 1_000_000;
  const { issuer } = await harness(now);
  for (let i = 1; i <= 30; i += 1) {
    await issuer.issue({
      requestId: `min-${i}`, buyerKeyId: `buyer-${i}`, productVersion: 'product-v1', expectedAmountZat: '100',
    });
  }
  await expect(issuer.issue({
    requestId: 'min-31', buyerKeyId: 'buyer-31', productVersion: 'product-v1', expectedAmountZat: '100',
  })).rejects.toThrow(/rate_limited/);
});

test('expiry frees the per-buyer open-invoice slot', async () => {
  let clock = 1_000_000;
  const { issuer } = await harness(() => clock);
  const buyerKeyId = 'buyer-expiry';
  for (let i = 1; i <= 3; i += 1) {
    await issuer.issue({
      requestId: `exp-${i}`, buyerKeyId, productVersion: 'product-v1', expectedAmountZat: '100',
    });
  }
  await expect(issuer.issue({
    requestId: 'exp-4', buyerKeyId, productVersion: 'product-v1', expectedAmountZat: '100',
  })).rejects.toBeInstanceOf(RateLimitedError);

  clock = 1_001_001;
  const freed = await issuer.issue({
    requestId: 'exp-5', buyerKeyId, productVersion: 'product-v1', expectedAmountZat: '100',
  });
  expect(freed.buyerKeyId).toBe(buyerKeyId);
  expect(freed.expiresAt).toBe(clock + 1_000);
});

test('two concurrent issue calls with different requestIds and a cap of 1 cannot both allocate', async () => {
  let releaseHold: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  let markEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let calls = 0;
  const { issuer, allocations } = await harness(() => 1_000_000, {
    limits: { openInvoicesPerBuyer: 1, invoicesPerMinute: 30 },
    onAllocate: async () => {
      calls += 1;
      if (calls === 1) {
        markEntered();
        await hold;
      }
    },
  });
  const buyerKeyId = 'buyer-race';
  const issue = (requestId: string) => issuer.issue({
    requestId, buyerKeyId, productVersion: 'product-v1', expectedAmountZat: '100',
  });
  const first = issue('race-1');
  const second = issue('race-2');
  const secondDone = second.then(() => 'allocated' as const, (error: unknown) => error);
  await entered;
  await expect(secondDone).resolves.toBeInstanceOf(RateLimitedError);
  expect(allocations()).toBe(1);
  releaseHold();
  await expect(first).resolves.toMatchObject({ buyerKeyId });
  expect(allocations()).toBe(1);
});

test('a reserved draft occupies the per-minute cap before the invoice is committed', async () => {
  let releaseHold: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  let markEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let calls = 0;
  const { issuer, allocations } = await harness(() => 1_000_000, {
    limits: { openInvoicesPerBuyer: 3, invoicesPerMinute: 1 },
    onAllocate: async () => {
      calls += 1;
      if (calls === 1) {
        markEntered();
        await hold;
      }
    },
  });
  const issue = (requestId: string, buyerKeyId: string) => issuer.issue({
    requestId, buyerKeyId, productVersion: 'product-v1', expectedAmountZat: '100',
  });
  const first = issue('minute-1', 'buyer-minute-1');
  const second = issue('minute-2', 'buyer-minute-2');
  const secondDone = second.then(() => 'allocated' as const, (error: unknown) => error);
  await entered;
  await expect(secondDone).resolves.toBeInstanceOf(RateLimitedError);
  expect(allocations()).toBe(1);
  releaseHold();
  await expect(first).resolves.toMatchObject({ buyerKeyId: 'buyer-minute-1' });
  expect(allocations()).toBe(1);
});
