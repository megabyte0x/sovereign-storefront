import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import {
  DOWNLOAD_DONE_EVENT,
  UPLOAD_DONE_EVENT,
  createLogosStorageAdapter,
  type LogosRunner,
} from '../../src/adapters/storage.ts';
import { readOriginListenPort } from '../../src/adapters/live.ts';

// Task 10.7 live finding (mirrors scripts/live-infra/logos-up.ts): replica
// `connect <peer> json:[]` returns ok but DHT discovery never reaches a
// loopback-only origin, so the replica download fails with
// "Failed to start download.". The explicit loopback multiaddr connects, and
// a downloadToUrl issued right after connect can still fail transiently.
type Call = { configDir: string; method: string; args: string[] };

function runner(opts: { failDownloads?: number } = {}) {
  const calls: Call[] = [];
  let failures = opts.failDownloads ?? 0;
  const r: LogosRunner = {
    async call(configDir, method, args = []) {
      calls.push({ configDir, method, args });
      if (method === 'peerId') return 'peerORIGIN';
      if (method === 'exists') return true;
      if (method === 'manifests') return [];
      if (method === 'downloadToUrl' && failures > 0) {
        failures -= 1;
        throw new Error('module call failed: {"error":"Failed to start download.","success":false,"value":null}');
      }
      if (method === 'downloadToUrl') return 's1';
      return null;
    },
    subscribe(_configDir, eventName) {
      const event = eventName === UPLOAD_DONE_EVENT
        ? { success: true, cid: 'cid-1' }
        : eventName === DOWNLOAD_DONE_EVENT ? { success: true, sessionId: 's1' } : null;
      return { ready: Promise.resolve(), event: Promise.resolve(event), cancel: () => undefined };
    },
  };
  return { runner: r, calls };
}

const base = { logosctlPath: '/bin/logosctl', originConfigDir: '/origin', replicaConfigDir: '/replica' };
const bytes = new Uint8Array([1, 2, 3]);

const tmpRoot = process.env.TMPDIR ?? tmpdir();
function logosTmpDirs(): Set<string> {
  return new Set(readdirSync(tmpRoot).filter((name) => name.startsWith('ssf-logos-')));
}
const logosTmpBefore = logosTmpDirs();

// Every adapter gets a workDir under this file's own scratch root (removed
// in afterAll): without one, createLogosStorageAdapter mkdtemps
// $TMPDIR/ssf-logos-* and nothing ever removes it.
const unitScratch = mkdtempSync(join(tmpRoot, 'ssf-unit-logos-'));
afterAll(() => rmSync(unitScratch, { recursive: true, force: true }));
function makeAdapter(...[rt, deps, opts]: Parameters<typeof createLogosStorageAdapter>) {
  return createLogosStorageAdapter(rt, { workDir: mkdtempSync(join(unitScratch, 'w-')), ...deps }, opts);
}

test('publish connects the replica to the origin by its explicit loopback multiaddr', async () => {
  const { runner: r, calls } = runner();
  const adapter = makeAdapter({ ...base, originListenPort: 18091 }, { runner: r, readFile: () => bytes, writeFile: () => undefined });
  await adapter.publish(bytes);
  const connect = calls.find((c) => c.method === 'connect');
  expect(connect?.configDir).toBe('/replica');
  expect(connect?.args).toEqual(['peerORIGIN', 'json:["/ip4/127.0.0.1/tcp/18091/p2p/peerORIGIN"]']);
});

test('without a known origin port the empty address hint is kept', async () => {
  const { runner: r, calls } = runner();
  const adapter = makeAdapter(base, { runner: r, readFile: () => bytes, writeFile: () => undefined });
  await adapter.publish(bytes);
  expect(calls.find((c) => c.method === 'connect')?.args).toEqual(['peerORIGIN', 'json:[]']);
});

test('a transient "Failed to start download." is retried with a fresh watch', async () => {
  const { runner: r, calls } = runner({ failDownloads: 2 });
  const adapter = makeAdapter(base, { runner: r, readFile: () => bytes, writeFile: () => undefined }, { downloadRetryDelayMs: 0 });
  expect(await adapter.verifyReplica('cid-1', 'replica')).toBe(true);
  expect(calls.filter((c) => c.method === 'downloadToUrl')).toHaveLength(3);
});

test('download retries are bounded', async () => {
  const { runner: r } = runner({ failDownloads: 99 });
  const adapter = makeAdapter(base, { runner: r, readFile: () => bytes, writeFile: () => undefined }, { downloadRetryDelayMs: 0 });
  await expect(adapter.fetch('cid-1')).rejects.toThrow(/Failed to start download/);
});

test('readOriginListenPort reads listen-port from the origin storage-init.json, else undefined', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-init-'));
  expect(readOriginListenPort(dir)).toBeUndefined();
  writeFileSync(join(dir, 'storage-init.json'), JSON.stringify({ 'listen-port': 18091, 'disc-port': 18090 }));
  expect(readOriginListenPort(dir)).toBe(18091);
  writeFileSync(join(dir, 'storage-init.json'), JSON.stringify({ 'listen-port': 'x' }));
  expect(readOriginListenPort(dir)).toBeUndefined();
});

// Leak guard: an adapter created without a workDir mkdtemps
// $TMPDIR/ssf-logos-*; this file must not leave any behind.
test('this file leaves no new $TMPDIR/ssf-logos-* dirs behind', () => {
  const leaked = [...logosTmpDirs()].filter((name) => !logosTmpBefore.has(name));
  expect(leaked).toEqual([]);
});
