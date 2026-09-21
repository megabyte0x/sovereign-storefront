import http from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { FIRST_RELEASE_MAX_CIPHERTEXT_BYTES } from '../../src/adapters/crypto.ts';
import { createCiphertextHandler } from '../../src/gateway/ciphertext.ts';

type Started = {
  url: string;
  close: () => Promise<void>;
};

const lookups: string[] = [];
const upstreamFetches: string[] = [];
let published = new Map<string, Uint8Array>();
let replicaConnected = true;
let lookupDelayMs = 0;
let servers: Started[] = [];

function fixtureCiphertext(size = FIRST_RELEASE_MAX_CIPHERTEXT_BYTES): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('SSF1'));
  bytes.fill(7, 4);
  return bytes;
}

async function listen(handler: http.RequestListener): Promise<Started> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server did not bind');
  }
  const started = {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
  servers.push(started);
  return started;
}

async function request(baseUrl: string, path: string): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    http.get({ hostname: base.hostname, port: base.port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    }).on('error', reject);
  });
}

function handler(overrides: {
  maxConcurrent?: number;
  maxCiphertextBytes?: number;
} = {}) {
  return createCiphertextHandler({
    maxConcurrent: overrides.maxConcurrent ?? 2,
    maxCiphertextBytes: overrides.maxCiphertextBytes ?? FIRST_RELEASE_MAX_CIPHERTEXT_BYTES,
    async getPublishedCiphertext(productVersion: string) {
      lookups.push(productVersion);
      if (lookupDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, lookupDelayMs));
      }
      if (!replicaConnected) {
        throw new Error('replica unavailable');
      }
      const body = published.get(productVersion);
      if (!body) {
        throw new Error('unpublished product');
      }
      return body;
    },
  });
}

afterEach(async () => {
  lookups.length = 0;
  upstreamFetches.length = 0;
  published = new Map([['book-v1', fixtureCiphertext()]]);
  replicaConnected = true;
  lookupDelayMs = 0;
  const closing = servers.splice(0);
  await Promise.all(closing.map((s) => s.close()));
});

published = new Map([['book-v1', fixtureCiphertext()]]);

test('unpublished product is rejected without an upstream fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    upstreamFetches.push(String(input));
    throw new Error('fetch must not run');
  }) as typeof fetch;
  try {
    const { url } = await listen(handler());
    const res = await request(url, '/ciphertext/unpublished-v1');
    expect(res.status).toBe(404);
    expect(res.body.includes(Buffer.from('SSF1'))).toBe(false);
    expect(upstreamFetches).toEqual([]);
    expect(lookups.every((id) => id === 'unpublished-v1')).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('traversal and arbitrary URLs are rejected without lookups or fetches', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    upstreamFetches.push(String(input));
    throw new Error('fetch must not run');
  }) as typeof fetch;
  try {
    const { url } = await listen(handler());
    const abuses = [
      '/ciphertext/../book-v1',
      '/ciphertext/%2e%2e/book-v1',
      '/ciphertext/book-v1/../../etc/passwd',
      '/ciphertext/foo/bar',
      '/ciphertext/book-v1%2f..%2fsecret',
      '/etc/passwd',
      '/ciphertext/./book-v1',
      '/http://evil.example/ciphertext/book-v1',
      '/daemon/status',
      '/call/storage_module/uploadUrl',
      '/watch/storage_module',
    ];
    for (const path of abuses) {
      const res = await request(url, path);
      expect(res.status, path).toBe(400);
      expect(res.body.includes(Buffer.from('SSF1')), path).toBe(false);
    }
    expect(lookups).toEqual([]);
    expect(upstreamFetches).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invalid identifiers are rejected without a storage lookup', async () => {
  const { url } = await listen(handler());
  const invalid = [
    '/ciphertext/',
    '/ciphertext/has%20space',
    '/ciphertext/book.v1',
    '/ciphertext/book:v1',
    '/ciphertext/' + 'x'.repeat(129),
  ];
  for (const path of invalid) {
    const res = await request(url, path);
    expect(res.status, path).toBe(400);
    expect(res.body.includes(Buffer.from('SSF1')), path).toBe(false);
  }
  expect(lookups).toEqual([]);
});

test('oversize ciphertext is rejected before the body is served', async () => {
  published.set('huge-v1', fixtureCiphertext(FIRST_RELEASE_MAX_CIPHERTEXT_BYTES + 1));
  const { url } = await listen(handler());
  const res = await request(url, '/ciphertext/huge-v1');
  expect(res.status).toBe(413);
  expect(res.body.byteLength).toBeLessThan(FIRST_RELEASE_MAX_CIPHERTEXT_BYTES + 1);
  expect(res.body.includes(Buffer.from('SSF1'))).toBe(false);
});

test('excess concurrency is rejected without extra lookups', async () => {
  lookupDelayMs = 200;
  const { url } = await listen(handler({ maxConcurrent: 1 }));
  const first = request(url, '/ciphertext/book-v1');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await request(url, '/ciphertext/book-v1');
  expect(second.status).toBe(429);
  expect(second.body.includes(Buffer.from('SSF1'))).toBe(false);
  const firstRes = await first;
  expect(firstRes.status).toBe(200);
  expect(lookups).toEqual(['book-v1']);
});

test('disconnected replica errors without arbitrary upstream fetches', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    upstreamFetches.push(String(input));
    throw new Error('fetch must not run');
  }) as typeof fetch;
  replicaConnected = false;
  try {
    const { url } = await listen(handler());
    const res = await request(url, '/ciphertext/book-v1');
    expect(res.status).toBe(503);
    expect(res.body.includes(Buffer.from('SSF1'))).toBe(false);
    expect(upstreamFetches).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('valid published identifier is served as an attachment and never as HTML', async () => {
  const payload = fixtureCiphertext();
  published.set('book-v1', payload);
  const { url } = await listen(handler());
  const res = await request(url, '/ciphertext/book-v1');
  expect(res.status).toBe(200);
  expect(Buffer.from(res.body)).toEqual(Buffer.from(payload));
  expect(res.headers['content-type']).toMatch(/application\/octet-stream/);
  expect(String(res.headers['content-disposition'] ?? '')).toMatch(/attachment/i);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(String(res.headers['content-type'])).not.toMatch(/html/i);
});

test('query strings cannot smuggle keys or logos methods', async () => {
  const { url } = await listen(handler());
  const res = await request(url, '/ciphertext/book-v1?key=secret&call=uploadUrl');
  expect(res.status).toBe(200);
  expect(lookups).toEqual(['book-v1']);
  expect(String(res.headers['content-type'])).not.toMatch(/json/i);
});
