import { createHash } from 'node:crypto';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { LogosRunner } from '../../src/adapters/storage.ts';
import { createReplicaAgentHandler } from '../../src/replica-agent/handlers.ts';
import { assertReplicaBindHost, readReplicaToken } from '../../src/replica-agent/main.ts';

const TOKEN = 'replica-agent-test-token';
const CID = `z${'1'.repeat(51)}`;
const PEER = `16Uiu2HAm${'A'.repeat(40)}`;
const ADDR = `/ip4/127.0.0.1/tcp/8091/p2p/${PEER}`;

type Call = { method: string; args: string[] };

function fakeRunner(bytes: Uint8Array): { runner: LogosRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: LogosRunner = {
    async call(_configDir, method, args = []) {
      calls.push({ method, args: [...args] });
      if (method === 'peerId') return PEER;
      if (method === 'downloadToUrl' && args[1]) writeFileSync(args[1], bytes);
      if (method === 'downloadToUrl') return 'session-1';
      return true;
    },
    subscribe() {
      return {
        ready: Promise.resolve(),
        event: Promise.resolve({ success: true, sessionId: 'session-1' }),
        cancel() {},
      };
    },
  };
  return { runner, calls };
}

let server: Server | undefined;
let dir: string | undefined;

afterEach(async () => {
  if (server) {
    const closing = server;
    server = undefined;
    closing.closeAllConnections();
    const { promise, resolve } = Promise.withResolvers<void>();
    closing.close(() => resolve());
    await promise;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  server = createServer(handler);
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => resolve());
  await promise;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function call(
  base: string,
  method: string,
  path: string,
  body?: string,
  token?: string,
): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string; json: Record<string, unknown> | null }>();
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = request(`${base}${path}`, { method, headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json: Record<string, unknown> | null = null;
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
      resolve({ status: res.statusCode ?? 0, text, json });
    });
  });
  req.on('error', reject);
  if (body !== undefined) req.end(body);
  else req.end();
  return promise;
}

test('rejects a request with no bearer token', async () => {
  const { runner } = fakeRunner(new Uint8Array([1]));
  const logs: string[] = [];
  const base = await listen(createReplicaAgentHandler({
    runner,
    configDir: '/logos/node-b',
    token: TOKEN,
    log: (record) => logs.push(JSON.stringify(record)),
  }));
  const res = await call(base, 'GET', '/v1/peer');
  expect(res.status).toBe(401);
  expect(res.text).not.toContain(TOKEN);
  expect(logs.join('\n')).not.toContain(TOKEN);
});

test('has is false when the replica bytes do not match the digest', async () => {
  const bytes = new Uint8Array([4, 5, 6]);
  const { runner } = fakeRunner(bytes);
  const logs: string[] = [];
  const base = await listen(createReplicaAgentHandler({
    runner,
    configDir: '/logos/node-b',
    token: TOKEN,
    log: (record) => logs.push(JSON.stringify(record)),
  }));
  const wrong = 'a'.repeat(64);
  const res = await call(base, 'GET', `/v1/has/${CID}?digest=${wrong}&size=${bytes.byteLength}`, undefined, TOKEN);
  expect(res.status).toBe(200);
  expect(res.json).toEqual({ present: false });
  const logged = logs.join('\n');
  expect(logged).not.toContain(CID);
  expect(logged).not.toContain(wrong);
});

test('replicate is idempotent for the same CID', async () => {
  const bytes = new Uint8Array([7]);
  const { runner, calls } = fakeRunner(bytes);
  const base = await listen(createReplicaAgentHandler({
    runner,
    configDir: '/logos/node-b',
    token: TOKEN,
    downloadRetryDelayMs: 0,
  }));
  const body = JSON.stringify({
    cid: CID,
    originMultiaddr: ADDR,
    digest: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
  });
  const first = await call(base, 'POST', '/v1/replicate', body, TOKEN);
  const second = await call(base, 'POST', '/v1/replicate', body, TOKEN);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(second.json).toEqual(first.json);
  expect(calls.filter((entry) => entry.method === 'downloadToUrl' && entry.args[2] === 'false')).toHaveLength(1);
});

test('an unknown path is 404 and a bad CID is 400', async () => {
  const { runner } = fakeRunner(new Uint8Array([1]));
  const base = await listen(createReplicaAgentHandler({
    runner,
    configDir: '/logos/node-b',
    token: TOKEN,
  }));
  expect((await call(base, 'GET', '/v1/nope', undefined, TOKEN)).status).toBe(404);
  // `0` is outside base58. A weaker alphanumeric CID check would accept this.
  expect((await call(base, 'GET', `/v1/has/z${'0'.repeat(51)}?digest=${'b'.repeat(64)}&size=1`, undefined, TOKEN)).status).toBe(400);
  expect((await call(base, 'GET', '/v1/has/not-a-cid?digest=ab&size=1', undefined, TOKEN)).status).toBe(400);
});

test('the agent bind accepts a tailnet address or in-container 0.0.0.0', () => {
  expect(() => assertReplicaBindHost('100.114.129.39')).not.toThrow();
  expect(() => assertReplicaBindHost('0.0.0.0')).not.toThrow();
  expect(() => assertReplicaBindHost('127.0.0.1')).toThrow(/tailnet|0\.0\.0\.0/);
  expect(() => assertReplicaBindHost('8.8.8.8')).toThrow(/tailnet|0\.0\.0\.0/);
});

test('a group-readable token file is refused', () => {
  dir = mkdtempSync(join(tmpdir(), 'ssf-replica-token-'));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o644);
  expect(() => readReplicaToken(tokenFile)).toThrow(/0600/);
});

test('has is present only when the download watch was armed before downloadToUrl', async () => {
  const bytes = new Uint8Array([9, 9, 1]);
  const order: string[] = [];
  let armed = false;
  let deliver: ((event: { success: boolean; sessionId: string; bytes: number }) => void) | undefined;
  const runner: LogosRunner = {
    async call(_configDir, method, args = []) {
      order.push(method);
      if (method === 'peerId') return PEER;
      if (method === 'downloadToUrl') {
        if (args[1]) writeFileSync(args[1], bytes);
        if (armed && deliver) deliver({ success: true, sessionId: 'session-1', bytes: bytes.byteLength });
        return 'session-1';
      }
      return true;
    },
    subscribe() {
      order.push('subscribe');
      armed = true;
      let resolve: (event: { success: boolean; sessionId: string; bytes: number } | null) => void = () => undefined;
      const event = new Promise<{ success: boolean; sessionId: string; bytes: number } | null>((res) => {
        resolve = res;
      });
      deliver = (value) => resolve(value);
      return { ready: Promise.resolve(), event, cancel() { resolve(null); } };
    },
  };
  const base = await listen(createReplicaAgentHandler({
    runner,
    configDir: '/logos/node-b',
    token: TOKEN,
    watchTimeoutMs: 40,
    downloadRetryDelayMs: 0,
  }));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const res = await call(base, 'GET', `/v1/has/${CID}?digest=${digest}&size=${bytes.byteLength}`, undefined, TOKEN);
  expect(res.status).toBe(200);
  expect(res.json).toEqual({ present: true });
  expect(order.indexOf('subscribe')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('subscribe')).toBeLessThan(order.indexOf('downloadToUrl'));
});
