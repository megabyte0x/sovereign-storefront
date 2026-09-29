import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { LogosRunner } from '../../src/adapters/storage.ts';
import { createRemoteReplica } from '../../src/adapters/remote-replica.ts';
import { createReplicaAgentHandler } from '../../src/replica-agent/handlers.ts';

const TOKEN = 'remote-replica-test-token';
const CID = `z${'1'.repeat(51)}`;
const OTHER = `z${'2'.repeat(51)}`;
const PEER = `16Uiu2HAm${'A'.repeat(40)}`;
const OTHER_PEER = `16Uiu2HAm${'B'.repeat(40)}`;
const ADDR = `/ip4/127.0.0.1/tcp/8091/p2p/${PEER}`;

function fakeRunner(bytes: Uint8Array, hangLocal = false): LogosRunner {
  return {
    async call(_configDir, method, args = []) {
      if (method === 'peerId') return PEER;
      if (method === 'downloadToUrl' && args[2] === 'true' && hangLocal) return new Promise(() => undefined);
      if (method === 'downloadToUrl' && args[1]) writeFileSync(args[1], bytes);
      return method === 'downloadToUrl' ? 'session-1' : true;
    },
    subscribe() {
      return {
        ready: Promise.resolve(),
        event: Promise.resolve({ success: true, sessionId: 'session-1' }),
        cancel() {},
      };
    },
  };
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

function tokenFile(contents = TOKEN, mode = 0o600): string {
  dir = mkdtempSync(join(tmpdir(), 'ssf-remote-replica-'));
  const path = join(dir, 'token');
  writeFileSync(path, `${contents}\n`, { mode: 0o600 });
  chmodSync(path, mode);
  return path;
}

async function serve(bytes: Uint8Array, hangLocal = false): Promise<string> {
  server = createServer(createReplicaAgentHandler({
    runner: fakeRunner(bytes, hangLocal),
    configDir: '/logos/node-b',
    token: TOKEN,
    downloadRetryDelayMs: 0,
  }));
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => resolve());
  await promise;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('verifyReplica is true only when the replica reports present', async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const url = await serve(bytes);
  const remote = createRemoteReplica({ url, tokenFile: tokenFile(), timeoutMs: 200, maxBytes: 1024 });
  await remote.replicate({
    cid: CID,
    originMultiaddr: ADDR,
    digest: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
  });
  expect(await remote.verifyReplica(CID, 'replica')).toBe(true);
  await remote.replicate({
    cid: OTHER,
    originMultiaddr: ADDR,
    digest: 'c'.repeat(64),
    sizeBytes: bytes.byteLength,
  });
  expect(await remote.verifyReplica(OTHER, 'replica')).toBe(false);
});

test('a replica timeout is not ready, not a throw', async () => {
  const url = await serve(new Uint8Array([1, 2]), true);
  const remote = createRemoteReplica({ url, tokenFile: tokenFile(), timeoutMs: 40, maxBytes: 1024 });
  await remote.replicate({
    cid: CID,
    originMultiaddr: ADDR,
    digest: 'd'.repeat(64),
    sizeBytes: 2,
  });
  await expect(remote.verifyReplica(CID, 'replica')).resolves.toBe(false);
});

test('equal peer ids are rejected', async () => {
  const url = await serve(new Uint8Array([1]));
  const remote = createRemoteReplica({ url, tokenFile: tokenFile(), timeoutMs: 200, maxBytes: 1024 });
  await expect(remote.assertIndependentReplicas(PEER)).rejects.toThrow('logos origin and replica are not independent peers');
  await expect(remote.assertIndependentReplicas(OTHER_PEER)).resolves.toBeUndefined();
});

test('a non-tailnet http url is rejected', () => {
  expect(() => createRemoteReplica({
    url: 'http://8.8.8.8:8790',
    tokenFile: '/tmp/unused-replica-token',
    timeoutMs: 1000,
  })).toThrow(/tailnet|loopback/);
  const file = tokenFile();
  expect(() => createRemoteReplica({ url: 'http://100.64.0.1:8790', tokenFile: file, timeoutMs: 1000 })).not.toThrow();
  expect(() => createRemoteReplica({ url: 'http://127.0.0.1:9', tokenFile: file, timeoutMs: 1000 })).not.toThrow();
});

test('a ciphertext over the size cap is rejected', async () => {
  const url = await serve(new Uint8Array([1, 2, 3, 4]));
  const remote = createRemoteReplica({ url, tokenFile: tokenFile(), timeoutMs: 200, maxBytes: 2 });
  await expect(remote.fetch(CID)).rejects.toThrow(/size cap/);
});
