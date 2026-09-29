import http from 'node:http';
import { expect, test } from 'vitest';
import { downloadCiphertext } from '../../src/browser/download.ts';
import { sha256Hex } from '../../src/adapters/crypto.ts';
import type { ServeCiphertextOptions } from '../../src/contracts/public.ts';
import { inspectCiphertextPath, serveCiphertext } from '../../src/gateway/ciphertext.ts';

function fixture(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i & 0xff;
  return bytes;
}

function listen(server: http.Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => resolve());
  return promise;
}

function close(server: http.Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((err) => (err ? reject(err) : resolve()));
  return promise;
}

function request(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const base = new URL(baseUrl);
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  }>();
  const req = http.request(
    { hostname: base.hostname, port: base.port, path, method: 'GET', headers },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    },
  );
  req.on('error', reject);
  req.end();
  return promise;
}

async function withGateway(
  body: Uint8Array,
  fn: (baseUrl: string, lookups: string[]) => Promise<void>,
  lookup: (productVersion: string) => Promise<Uint8Array> = async () => body,
): Promise<void> {
  const lookups: string[] = [];
  const options: ServeCiphertextOptions = { maxBytes: body.byteLength, digest: sha256Hex(body) };
  const server = http.createServer((req, res) => {
    void serveCiphertext(req, res, async (productVersion) => {
      lookups.push(productVersion);
      return lookup(productVersion);
    }, options);
  });
  await listen(server);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind');
  try {
    await fn(`http://127.0.0.1:${addr.port}`, lookups);
  } finally {
    await close(server);
  }
}

test('GET returns 200 and the sha256 ETag', async () => {
  const body = fixture(1000);
  const digest = sha256Hex(body);
  await withGateway(body, async (baseUrl) => {
    const res = await request(baseUrl, '/ciphertext/book-v1');
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body)).toEqual(Buffer.from(body));
    expect(res.headers.etag).toBe(`"${digest}"`);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(String(res.headers['content-type'])).toMatch(/application\/octet-stream/);
  });
});

test('a single byte range returns 206 with Content-Range', async () => {
  const body = fixture(1000);
  await withGateway(body, async (baseUrl) => {
    const res = await request(baseUrl, '/ciphertext/book-v1', { Range: 'bytes=0-99' });
    expect(res.status).toBe(206);
    expect(res.body.byteLength).toBe(100);
    expect(Buffer.from(res.body)).toEqual(Buffer.from(body.subarray(0, 100)));
    expect(res.headers['content-range']).toBe('bytes 0-99/1000');
  });
});

test('a multi-range request returns 416', async () => {
  await withGateway(fixture(1000), async (baseUrl) => {
    const res = await request(baseUrl, '/ciphertext/book-v1', { Range: 'bytes=0-9,20-29' });
    expect(res.status).toBe(416);
    expect(res.body.equals(Buffer.from(fixture(1000)))).toBe(false);
  });
});

test('If-None-Match of the ETag returns 304', async () => {
  const body = fixture(64);
  const digest = sha256Hex(body);
  await withGateway(body, async (baseUrl) => {
    const fresh = await request(baseUrl, '/ciphertext/book-v1');
    expect(fresh.status).toBe(200);
    const cached = await request(baseUrl, '/ciphertext/book-v1', { 'If-None-Match': `"${digest}"` });
    expect(cached.status).toBe(304);
    expect(cached.body.byteLength).toBe(0);
    const other = await request(baseUrl, '/ciphertext/book-v1', { 'If-None-Match': '"not-the-etag"' });
    expect(other.status).toBe(200);
  });
});

test('path traversal still returns 400 via inspectCiphertextPath', async () => {
  const abuses = ['/ciphertext/../book-v1', '/ciphertext/%2e%2e/book-v1', '/ciphertext/./book-v1'];
  for (const path of abuses) {
    expect(inspectCiphertextPath(path)).toEqual({ ok: false, status: 400 });
  }
  await withGateway(fixture(32), async (baseUrl, lookups) => {
    for (const path of abuses) {
      const res = await request(baseUrl, path);
      expect(res.status, path).toBe(400);
    }
    expect(lookups).toEqual([]);
  });
});

test('downloadCiphertext returns the bytes and rejects a digest mismatch', async () => {
  const body = fixture(128);
  const digest = sha256Hex(body);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.byteLength) });
    res.end(Buffer.from(body));
  });
  await listen(server);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind');
  const url = `http://127.0.0.1:${addr.port}/ciphertext/book-v1`;
  const seen: number[] = [];
  try {
    const downloaded = await downloadCiphertext(url, digest, (loaded) => seen.push(loaded), 256);
    expect(downloaded).toEqual(body);
    const flipped = digest.slice(0, -1) + (digest.endsWith('a') ? 'b' : 'a');
    await expect(downloadCiphertext(url, flipped)).rejects.toThrow(/digest mismatch/);
  } finally {
    await close(server);
  }
});
test('downloadCiphertext counts chunked bytes without Content-Length and fails closed without a stream', async () => {
  const body = fixture(257);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(Buffer.from(body));
    res.end();
  });
  await listen(server);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind');
  const url = `http://127.0.0.1:${addr.port}/ciphertext/book-v1`;
  try {
    await expect(downloadCiphertext(url, sha256Hex(body), undefined, 256)).rejects.toThrow(/too large/i);
    await expect(downloadCiphertext(
      url,
      sha256Hex(body),
      undefined,
      256,
      async () => new Response(null),
    )).rejects.toThrow(/streaming unavailable/i);
  } finally {
    await close(server);
  }
});
test('downloadCiphertext counts body bytes when Content-Length under-reports', async () => {
  const body = fixture(257);
  const response = new Response(body, {
    headers: { 'content-length': '1', 'content-type': 'application/octet-stream' },
  });
  await expect(downloadCiphertext(
    '/ciphertext/book-v1',
    sha256Hex(body),
    undefined,
    256,
    async () => response,
  )).rejects.toThrow(/too large/i);
});
