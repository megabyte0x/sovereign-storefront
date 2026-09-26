import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  DEFAULT_REGISTRY_PATH,
  createLiveResourceRegistry,
  type ProcessLayer,
} from '../../scripts/live-resources.ts';

type FakeProc = { argv: string[]; alive: boolean; diesOn?: NodeJS.Signals };

/** Fake process table: nothing here ever touches a real process. */
function fakeProcesses(table: Record<number, FakeProc>) {
  const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const layer: ProcessLayer = {
    readCmdline(pid) {
      const p = table[pid];
      return p && p.alive ? [...p.argv] : undefined;
    },
    kill(pid, signal) {
      kills.push({ pid, signal });
      const p = table[pid];
      if (!p || !p.alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (p.diesOn === undefined || p.diesOn === signal) p.alive = false;
    },
    isAlive(pid) {
      return table[pid]?.alive === true;
    },
    sleep: async () => {},
  };
  return { layer, kills, table };
}

let root: string;
let demoDir: string;
let scratchRoot: string;
let registryPath: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ssf-live-resources-test-'));
  demoDir = path.join(root, 'demo');
  scratchRoot = path.join(root, 'scratch');
  mkdirSync(scratchRoot);
  registryPath = path.join(demoDir, 'resources.json');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const SELLER_ARGV = ['/usr/bin/node', '/repo/dist/scripts/start-live.js', '--db', '/repo/.runtime/live/seller/seller.sqlite'];

function registry(layer: ProcessLayer) {
  return createLiveResourceRegistry({ path: registryPath, processes: layer, scratchRoots: [scratchRoot] });
}

test('default registry path lives under .runtime/live/demo/', () => {
  expect(DEFAULT_REGISTRY_PATH.endsWith(path.join('.runtime', 'live', 'demo', 'resources.json'))).toBe(true);
});

test('registry file is written 0600 under a 0700 dir and records every resource kind', () => {
  const { layer } = fakeProcesses({ 100: { argv: SELLER_ARGV, alive: true } });
  const reg = registry(layer);
  reg.registerPid({ pid: 100, binary: 'node', ownedPath: '/repo/dist/scripts/start-live.js', label: 'seller' });
  reg.registerPort({ port: 4173, label: 'seller-public' });
  const dir = path.join(scratchRoot, 'ssf-logos-a1');
  mkdirSync(dir);
  reg.registerScratchDir({ path: dir, label: 'logos-scratch' });
  reg.registerCid({ cid: 'zDvZRwzm1abc', label: 'catalog' });
  reg.registerInvoiceId({ id: 'inv_01H123', label: 'l01' });
  reg.registerOrderId({ id: 'ord_01H123', label: 'l01' });
  reg.registerWakuContentTopic({ topic: '/ssf/1/orders/proto', label: 'orders' });
  const profile = path.join(scratchRoot, 'profile-b');
  mkdirSync(profile);
  reg.registerBrowserProfileDir({ path: profile, label: 'buyer-b' });

  expect(statSync(registryPath).mode & 0o777).toBe(0o600);
  expect(statSync(demoDir).mode & 0o777).toBe(0o700);
  const disk = JSON.parse(readFileSync(registryPath, 'utf8'));
  expect(disk.version).toBe(1);
  const kinds = disk.resources.map((r: { kind: string }) => r.kind).sort();
  expect(kinds).toEqual(
    ['browserProfileDir', 'cid', 'invoiceId', 'orderId', 'pid', 'port', 'scratchDir', 'wakuContentTopic'].sort(),
  );
});

test('an unregistered PID is never killed', async () => {
  const { layer, kills, table } = fakeProcesses({
    100: { argv: SELLER_ARGV, alive: true },
    200: { argv: SELLER_ARGV, alive: true }, // identical cmdline, but not registered
  });
  const reg = registry(layer);
  reg.registerPid({ pid: 100, binary: 'node', ownedPath: '/repo/dist/scripts/start-live.js', label: 'seller' });
  const report = await reg.cleanup();
  expect(kills.every((k) => k.pid === 100)).toBe(true);
  expect(kills.some((k) => k.pid === 100 && k.signal === 'SIGTERM')).toBe(true);
  expect(table[200].alive).toBe(true);
  expect(report.pids).toEqual([{ pid: 100, label: 'seller', outcome: 'stopped' }]);
});

test('a PID whose cmdline changed is skipped and reported, not killed', async () => {
  const { layer, kills, table } = fakeProcesses({ 100: { argv: SELLER_ARGV, alive: true } });
  const reg = registry(layer);
  reg.registerPid({ pid: 100, binary: 'node', ownedPath: '/repo/dist/scripts/start-live.js', label: 'seller' });
  // PID reused by an unrelated process.
  table[100] = { argv: ['/usr/bin/zcashd', '-datadir=/home/x/.zcash'], alive: true };
  const report = await reg.cleanup();
  expect(kills).toEqual([]);
  expect(table[100].alive).toBe(true);
  expect(report.pids).toEqual([{ pid: 100, label: 'seller', outcome: 'skipped-cmdline-changed' }]);
  expect(report.ok).toBe(false);
});

test('binary match alone is not enough: owned path must appear in argv', async () => {
  const { layer, kills } = fakeProcesses({ 100: { argv: ['/usr/bin/node', '/other/app.js'], alive: true } });
  const reg = registry(layer);
  reg.registerPid({ pid: 100, binary: 'node', ownedPath: '/repo/dist/scripts/start-live.js', label: 'seller' });
  const report = await reg.cleanup();
  expect(kills).toEqual([]);
  expect(report.pids[0].outcome).toBe('skipped-cmdline-changed');
});

test('a process that ignores SIGTERM is reported, never SIGKILLed', async () => {
  const { layer, kills } = fakeProcesses({ 100: { argv: SELLER_ARGV, alive: true, diesOn: 'SIGINT' } });
  const reg = registry(layer);
  reg.registerPid({ pid: 100, binary: 'node', ownedPath: '/repo/dist/scripts/start-live.js', label: 'seller' });
  const report = await reg.cleanup();
  expect(kills.map((k) => k.signal)).toEqual(['SIGTERM']);
  expect(report.pids[0].outcome).toBe('still-running');
  expect(report.ok).toBe(false);
});

test('a registered PID that already exited is reported gone', async () => {
  const { layer, kills } = fakeProcesses({ 100: { argv: SELLER_ARGV, alive: false } });
  const reg = registry(layer);
  reg.registerPid({ pid: 100, binary: 'node', ownedPath: '/repo/dist/scripts/start-live.js', label: 'seller' });
  const report = await reg.cleanup();
  expect(kills).toEqual([]);
  expect(report.pids[0].outcome).toBe('gone');
  expect(report.ok).toBe(true);
});

test('cleanup removes only registered scratch dirs', async () => {
  const { layer } = fakeProcesses({});
  const reg = registry(layer);
  const owned = path.join(scratchRoot, 'ssf-logos-owned');
  const other = path.join(scratchRoot, 'ssf-logos-other');
  mkdirSync(owned);
  mkdirSync(other);
  writeFileSync(path.join(owned, 'f'), 'x');
  reg.registerScratchDir({ path: owned, label: 'logos' });
  const report = await reg.cleanup();
  expect(existsSync(owned)).toBe(false);
  expect(existsSync(other)).toBe(true);
  expect(report.dirs).toEqual([{ path: owned, label: 'logos', outcome: 'removed' }]);
});

test('scratch dirs outside the allowed roots or equal to a root are refused at registration', () => {
  const { layer } = fakeProcesses({});
  const reg = registry(layer);
  expect(() => reg.registerScratchDir({ path: scratchRoot, label: 'x' })).toThrow(/scratch/);
  expect(() => reg.registerScratchDir({ path: '/etc', label: 'x' })).toThrow(/scratch/);
  expect(() => reg.registerScratchDir({ path: path.join(scratchRoot, '..', 'demo'), label: 'x' })).toThrow(/scratch/);
  expect(() => reg.registerScratchDir({ path: 'relative/dir', label: 'x' })).toThrow(/absolute/);
});

test('a scratch dir replaced by a symlink is skipped, and its target survives', async () => {
  const { layer } = fakeProcesses({});
  const reg = registry(layer);
  const owned = path.join(scratchRoot, 'ssf-logos-owned');
  mkdirSync(owned);
  reg.registerScratchDir({ path: owned, label: 'logos' });
  rmSync(owned, { recursive: true });
  const target = path.join(root, 'precious');
  mkdirSync(target);
  symlinkSync(target, owned);
  const report = await reg.cleanup();
  expect(existsSync(target)).toBe(true);
  expect(report.dirs[0].outcome).toBe('skipped-not-directory');
});

test('cleanup is idempotent, including across a reload from disk', async () => {
  const { layer, kills } = fakeProcesses({ 100: { argv: SELLER_ARGV, alive: true } });
  const reg = registry(layer);
  reg.registerPid({ pid: 100, binary: 'node', ownedPath: '/repo/dist/scripts/start-live.js', label: 'seller' });
  const dir = path.join(scratchRoot, 'ssf-logos-1');
  mkdirSync(dir);
  reg.registerScratchDir({ path: dir, label: 'logos' });
  const first = await reg.cleanup();
  expect(first.ok).toBe(true);
  const killsAfterFirst = kills.length;

  const second = await reg.cleanup();
  expect(kills.length).toBe(killsAfterFirst);
  expect(second.ok).toBe(true);
  expect(second.pids[0].outcome).toBe('already-cleaned');
  expect(second.dirs[0].outcome).toBe('already-cleaned');

  const reloaded = registry(layer);
  const third = await reloaded.cleanup();
  expect(kills.length).toBe(killsAfterFirst);
  expect(third.pids[0].outcome).toBe('already-cleaned');
});

test('the registry never records secrets: unknown keys and secret-looking values are rejected', () => {
  const { layer } = fakeProcesses({});
  const reg = registry(layer);
  const anyReg = reg as unknown as { registerCid(x: Record<string, unknown>): void; registerPort(x: Record<string, unknown>): void };
  expect(() => anyReg.registerCid({ cid: 'zDvabc', label: 'c', adminToken: 'tok' })).toThrow(/not allowed/);
  expect(() => anyReg.registerPort({ port: 1, label: 'p', ufvk: 'x' })).toThrow(/not allowed/);
  expect(() => reg.registerCid({ cid: 'uview1qqqqqqqqqqqqqqqq', label: 'c' })).toThrow(/secret/);
  expect(() => reg.registerInvoiceId({ id: 'uivk1abcdef', label: 'c' })).toThrow(/secret/);
  expect(() => reg.registerOrderId({ id: 'secret-extended-key-regtest1abc', label: 'c' })).toThrow(/secret/);
  expect(() => reg.registerCid({ cid: 'zDvabc', label: 'x'.repeat(65) })).toThrow(/label/);
  expect(() => reg.registerPid({ pid: 1, binary: 'node', ownedPath: '/repo/x', label: 's' })).toThrow(/pid/);
  expect(() => reg.registerPid({ pid: 100, binary: 'node', ownedPath: 'rel', label: 's' })).toThrow(/absolute/);
  expect(() => reg.registerPort({ port: 70000, label: 'p' })).toThrow(/port/);

  const allowed: Record<string, string[]> = {
    pid: ['kind', 'pid', 'binary', 'ownedPath', 'label', 'cleaned'],
    port: ['kind', 'port', 'label', 'cleaned'],
    scratchDir: ['kind', 'path', 'label', 'cleaned'],
    browserProfileDir: ['kind', 'path', 'label', 'cleaned'],
    cid: ['kind', 'cid', 'label', 'cleaned'],
    invoiceId: ['kind', 'id', 'label', 'cleaned'],
    orderId: ['kind', 'id', 'label', 'cleaned'],
    wakuContentTopic: ['kind', 'topic', 'label', 'cleaned'],
  };
  reg.registerCid({ cid: 'zDvabc', label: 'catalog' });
  reg.registerPort({ port: 4174, label: 'admin' });
  const disk = JSON.parse(readFileSync(registryPath, 'utf8'));
  expect(Object.keys(disk).sort()).toEqual(['resources', 'version']);
  for (const r of disk.resources) {
    for (const k of Object.keys(r)) expect(allowed[r.kind]).toContain(k);
  }
});

test('a tampered registry file with a non-allow-listed key is refused on load', () => {
  mkdirSync(demoDir, { mode: 0o700 });
  writeFileSync(
    registryPath,
    JSON.stringify({ version: 1, resources: [{ kind: 'cid', cid: 'zDv', label: 'c', cleaned: false, token: 't' }] }),
    { mode: 0o600 },
  );
  const { layer } = fakeProcesses({});
  expect(() => registry(layer)).toThrow(/not allowed/);
});

test('a re-registered duplicate is recorded once', () => {
  const { layer } = fakeProcesses({});
  const reg = registry(layer);
  reg.registerPort({ port: 4173, label: 'public' });
  reg.registerPort({ port: 4173, label: 'public' });
  expect(reg.snapshot().filter((r) => r.kind === 'port')).toHaveLength(1);
});
