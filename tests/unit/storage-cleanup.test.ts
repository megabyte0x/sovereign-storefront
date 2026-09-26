import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { DOWNLOAD_DONE_EVENT, createLogosStorageAdapter, type LogosRunner } from '../../src/adapters/storage.ts';

// Task 10 final review I1: every readiness probe (verifyReplica) and every
// fetch goes through downloadAndWait, which must not leave its
// download-<uuid>.ssf1 file behind in the adapter's workDir.
let workDir = '';

beforeEach(() => {
  workDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-storage-cleanup-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function downloadRunner(opts: { bytes?: Uint8Array; event?: Record<string, unknown> | null }): LogosRunner {
  return {
    async call(_configDir, method, args = []) {
      if (method === 'manifests') return [];
      if (method === 'downloadToUrl') {
        writeFileSync(args[1]!, opts.bytes ?? new Uint8Array(10));
        return 's1';
      }
      return null;
    },
    subscribe(_configDir, eventName) {
      const event = eventName === DOWNLOAD_DONE_EVENT
        ? (opts.event === undefined ? { success: true, sessionId: 's1' } : opts.event)
        : null;
      return { ready: Promise.resolve(), event: Promise.resolve(event), cancel: () => undefined };
    },
  };
}

const runtime = { logosctlPath: '/bin/logosctl', originConfigDir: '/origin', replicaConfigDir: '/replica' };

test('a successful fetch removes its download file', async () => {
  const adapter = createLogosStorageAdapter(runtime, { runner: downloadRunner({}), workDir });
  const bytes = await adapter.fetch('cid-1');
  expect(bytes.byteLength).toBe(10);
  expect(readdirSync(workDir)).toEqual([]);
});

test('a successful verifyReplica probe removes its download file', async () => {
  const adapter = createLogosStorageAdapter(runtime, { runner: downloadRunner({}), workDir });
  expect(await adapter.verifyReplica('cid-1', 'replica')).toBe(true);
  expect(await adapter.verifyReplica('cid-1', 'replica')).toBe(true);
  expect(readdirSync(workDir)).toEqual([]);
});

test('a failed download (unsuccessful event) removes its download file', async () => {
  const adapter = createLogosStorageAdapter(runtime, { runner: downloadRunner({ event: { success: false, sessionId: 's1' } }), workDir });
  await expect(adapter.fetch('cid-1')).rejects.toThrow(/download failed/);
  expect(readdirSync(workDir)).toEqual([]);
});

test('an oversized download is rejected and its file still removed', async () => {
  const adapter = createLogosStorageAdapter(runtime, { runner: downloadRunner({ bytes: new Uint8Array(200) }), workDir }, { maxBytes: 73 });
  await expect(adapter.fetch('cid-1')).rejects.toThrow();
  expect(await adapter.verifyReplica('cid-1', 'replica')).toBe(false);
  expect(readdirSync(workDir)).toEqual([]);
  expect(existsSync(workDir)).toBe(true);
});
