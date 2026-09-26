// Unit-test doubles only (memory storage, local crypto, temp DB): not live evidence.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createCryptoAdapter } from '../../src/adapters/crypto.ts';
import { createMemoryStorageAdapter, type MemoryStorageAdapter } from '../../src/adapters/storage.ts';
import type { OperationalLogger } from '../../src/ops/log.ts';
import { createAdminPublishHandler } from '../../src/seller/admin-publish.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';

const PLAINTEXT = new TextEncoder().encode('secret-book-plaintext-XYZ');

let dir: string;
let dbPath: string;
let server: Server | undefined;
let storage: MemoryStorageAdapter;
let records: Record<string, unknown>[];

function recordingLogger(): OperationalLogger {
  return {
    log(record) {
      records.push({ ...record });
    },
    lines() {
      return records.map((r) => JSON.stringify(r));
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ssf-admin-publish-'));
  dbPath = join(dir, 'seller.db');
  storage = createMemoryStorageAdapter();
  records = [];
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start(maxBodyBytes = 4096): Promise<string> {
  const handler = createAdminPublishHandler({
    dbPath,
    network: 'regtest',
    crypto: createCryptoAdapter(),
    storage,
    logger: recordingLogger(),
    maxBodyBytes,
  });
  server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('unhandled');
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> | null = null;
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 'book-v1',
    description: 'A real book',
    amountZat: '100000000',
    plaintextBase64: Buffer.from(PLAINTEXT).toString('base64'),
    ...overrides,
  };
}

function published(): string[] {
  const catalogue = openCatalogue({ dbPath, storage });
  try {
    return catalogue.listPublished().map((m) => m.version);
  } finally {
    catalogue.close();
  }
}

test('valid POST publishes the product and returns 201 with the CID', async () => {
  const base = await start();
  const res = await call(base, 'POST', '/admin/products', body());
  expect(res.status).toBe(201);
  expect(res.json).toMatchObject({ version: 'book-v1', replica: true });
  expect(typeof res.json?.ciphertextCid).toBe('string');
  expect(published()).toEqual(['book-v1']);
  expect(records).toContainEqual({ event: 'admin.publish', ok: true, code: 201 });
});

test('42-byte plaintext gives 413 and nothing is published', async () => {
  const base = await start();
  const res = await call(base, 'POST', '/admin/products', body({
    plaintextBase64: Buffer.alloc(42, 1).toString('base64'),
  }));
  expect(res.status).toBe(413);
  expect(published()).toEqual([]);
});

test('replica verification failure gives 503 and the product is not published', async () => {
  storage.setReplica(false);
  const base = await start();
  const res = await call(base, 'POST', '/admin/products', body());
  expect(res.status).toBe(503);
  expect(res.json).toEqual({ error: 'replica unavailable' });
  expect(published()).toEqual([]);
});

test('unavailable storage (publish throws) gives 503', async () => {
  storage.publish = async () => {
    throw new Error('logos down');
  };
  const base = await start();
  const res = await call(base, 'POST', '/admin/products', body());
  expect(res.status).toBe(503);
  expect(res.json).toEqual({ error: 'replica unavailable' });
});

test.each([
  ['bad version', { version: 'bad version!' }],
  ['non-integer amount', { amountZat: '1.5' }],
  ['numeric amount', { amountZat: 100 }],
  ['missing description', { description: '' }],
  ['bad base64', { plaintextBase64: 'not base64 !!' }],
])('%s gives 400', async (_name, overrides) => {
  const base = await start();
  const res = await call(base, 'POST', '/admin/products', body(overrides));
  expect(res.status).toBe(400);
  expect(published()).toEqual([]);
});

test('malformed JSON gives 400 and an oversized body gives 413', async () => {
  const base = await start();
  expect((await call(base, 'POST', '/admin/products', '{not json')).status).toBe(400);
  expect((await call(base, 'POST', '/admin/products', 'x'.repeat(5000))).status).toBe(413);
});

test('duplicate version gives 409', async () => {
  const base = await start();
  expect((await call(base, 'POST', '/admin/products', body())).status).toBe(201);
  const res = await call(base, 'POST', '/admin/products', body());
  expect(res.status).toBe(409);
  expect(published()).toEqual(['book-v1']);
});

test('non-matching paths and methods are not handled', async () => {
  const base = await start();
  expect((await call(base, 'GET', '/admin/products')).text).toBe('unhandled');
  expect((await call(base, 'POST', '/admin/health', body())).text).toBe('unhandled');
  expect((await call(base, 'POST', '/admin/products/x', body())).text).toBe('unhandled');
});

test('logs carry only event/ok/code and never plaintext, description or CID', async () => {
  const base = await start();
  const res = await call(base, 'POST', '/admin/products', body());
  await call(base, 'POST', '/admin/products', body());
  const cid = String(res.json?.ciphertextCid);
  const all = records.map((r) => JSON.stringify(r)).join('\n');
  expect(all).not.toContain(cid);
  expect(all).not.toContain('secret-book-plaintext');
  expect(all).not.toContain(Buffer.from(PLAINTEXT).toString('base64'));
  expect(all).not.toContain('A real book');
  for (const r of records) {
    expect(Object.keys(r).sort()).toEqual(['code', 'event', 'ok']);
    expect(r.event).toBe('admin.publish');
  }
});
