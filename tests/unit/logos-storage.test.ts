import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import {
  DOWNLOAD_DONE_EVENT,
  UPLOAD_DONE_EVENT,
  createLogosStorageAdapter,
  type LogosRunner,
} from '../../src/adapters/storage.ts';

type Call = { configDir: string; method: string; args: string[] };

/**
 * A fake `LogosRunner` that records every call/watch invocation (with the
 * configDir it targeted) and lets each test script exactly what `call`
 * returns and what `waitForEvent` resolves with, without spawning any real
 * process. This is what makes origin-vs-replica addressing and exact
 * event/CID correlation actually testable.
 */
function fakeRunner(overrides: {
  call?: (configDir: string, method: string, args: string[]) => unknown;
  waitForEvent?: (configDir: string, eventName: string, timeoutMs: number) => Promise<Record<string, unknown> | null>;
} = {}) {
  const calls: Call[] = [];
  const runner: LogosRunner = {
    async call(configDir, method, args = []) {
      calls.push({ configDir, method, args });
      if (overrides.call) return overrides.call(configDir, method, args);
      if (method === 'peerId') return `peer-${configDir}`;
      if (method === 'connect') return { connected: true };
      if (method === 'exists') return true;
      if (method === 'manifests') return [];
      return null;
    },
    subscribe(configDir, eventName, timeoutMs) {
      calls.push({ configDir, method: `watch:${eventName}`, args: [String(timeoutMs)] });
      return {
        ready: Promise.resolve(),
        event: overrides.waitForEvent ? overrides.waitForEvent(configDir, eventName, timeoutMs) : Promise.resolve(null),
        cancel: () => undefined,
      };
    },
  };
  return { runner, calls };
}

const ORIGIN = '/origin-config';
const REPLICA = '/replica-config';
const runtime = { logosctlPath: '/bin/logosctl', originConfigDir: ORIGIN, replicaConfigDir: REPLICA };

test('publish connects origin to replica, but fetching a warmed CID invokes only the replica', async () => {
  const ciphertext = new Uint8Array([1, 2, 3, 4]);
  let readFile: (path: string) => Uint8Array = () => ciphertext;
  const { runner, calls } = fakeRunner({
    waitForEvent: async (configDir, eventName) => {
      if (eventName === UPLOAD_DONE_EVENT) return { event: eventName, success: true, cid: 'cid-1' };
      if (eventName === DOWNLOAD_DONE_EVENT) return { event: eventName, success: true, cid: 'cid-1' };
      return null;
    },
  });
  const adapter = createLogosStorageAdapter(runtime, { runner, readFile: (p) => readFile(p), writeFile: () => undefined });

  const cid = await adapter.publish(ciphertext);
  expect(cid).toBe('cid-1');
  expect(calls.some((c) => c.configDir === ORIGIN && c.method === 'connect')).toBe(false);
  // Replication connect happens as part of publish, from replica to origin.
  expect(calls.some((c) => c.configDir === REPLICA && c.method === 'connect')).toBe(true);

  calls.length = 0;
  const fetched = await adapter.fetch(cid);
  expect(fetched).toEqual(ciphertext);
  expect(calls.every((c) => c.configDir === REPLICA)).toBe(true);
  expect(calls.some((c) => c.configDir === ORIGIN)).toBe(false);
});

test('verifyReplica also touches only the replica, never the origin', async () => {
  const ciphertext = new Uint8Array([9, 9]);
  const { runner, calls } = fakeRunner({
    waitForEvent: async (_configDir, eventName) => {
      if (eventName === DOWNLOAD_DONE_EVENT) return { event: eventName, success: true, cid: 'cid-2' };
      return null;
    },
  });
  const adapter = createLogosStorageAdapter(runtime, { runner, readFile: () => ciphertext, writeFile: () => undefined });
  const ok = await adapter.verifyReplica('cid-2', REPLICA);
  expect(ok).toBe(true);
  expect(calls.every((c) => c.configDir === REPLICA)).toBe(true);
});

test('a download event reporting a different CID than requested is not accepted as completion', async () => {
  const { runner } = fakeRunner({
    waitForEvent: async (_configDir, eventName) => {
      if (eventName === DOWNLOAD_DONE_EVENT) return { event: eventName, success: true, cid: 'wrong-cid' };
      return null;
    },
  });
  const adapter = createLogosStorageAdapter(runtime, { runner, readFile: () => new Uint8Array([1]), writeFile: () => undefined });
  await expect(adapter.fetch('cid-requested')).rejects.toThrow();
});

test('a download event reporting success:false is rejected, not read as a partial file', async () => {
  const { runner } = fakeRunner({
    waitForEvent: async (_configDir, eventName) => {
      if (eventName === DOWNLOAD_DONE_EVENT) return { event: eventName, success: false, cid: 'cid-3' };
      return null;
    },
  });
  const adapter = createLogosStorageAdapter(runtime, { runner, readFile: () => new Uint8Array([1]), writeFile: () => undefined });
  await expect(adapter.fetch('cid-3')).rejects.toThrow();
});

test('an upload-done event whose reported filename does not match the operation is not correlated to it', async () => {
  const { runner } = fakeRunner({
    waitForEvent: async (_configDir, eventName) => {
      if (eventName === UPLOAD_DONE_EVENT) return { event: eventName, success: true, cid: 'cid-4', filename: 'someone-elses-file.ssf1' };
      return null;
    },
  });
  const adapter = createLogosStorageAdapter(runtime, { runner, readFile: () => new Uint8Array([1]), writeFile: () => undefined });
  await expect(adapter.publish(new Uint8Array([1, 2]))).rejects.toThrow();
});

test('a hung watch (timeout, no event ever arrives) fails the operation rather than hanging or false-completing', async () => {
  const { runner } = fakeRunner({
    waitForEvent: async () => null, // simulates timeout: runner itself bounds the wait and gives up
  });
  const adapter = createLogosStorageAdapter(runtime, { runner, readFile: () => new Uint8Array([1]), writeFile: () => undefined });
  await expect(adapter.fetch('cid-hangs')).rejects.toThrow(/timed out|no event/i);
});

test('a process failure surfaces as a rejected operation, not a silently empty result', async () => {
  const { runner } = fakeRunner({
    call: () => { throw new Error('logosctl exited with status 1: connection refused'); },
  });
  const adapter = createLogosStorageAdapter(runtime, { runner, readFile: () => new Uint8Array([1]), writeFile: () => undefined });
  await expect(adapter.publish(new Uint8Array([1]))).rejects.toThrow(/exited with status 1/);
});

test('oversize downloaded content is rejected rather than returned', async () => {
  const big = new Uint8Array(1024);
  const { runner } = fakeRunner({
    waitForEvent: async (_configDir, eventName) => {
      if (eventName === DOWNLOAD_DONE_EVENT) return { event: eventName, success: true, cid: 'cid-big' };
      return null;
    },
  });
  const adapter = createLogosStorageAdapter(
    runtime,
    { runner, readFile: () => big, writeFile: () => undefined },
    { maxBytes: 100 },
  );
  await expect(adapter.fetch('cid-big')).rejects.toThrow();
});

test('two concurrent same-size publications each correlate to their own upload event, not a size-matched fallback', async () => {
  const events: Record<string, { cid: string; filename?: string }> = {};
  const filenames: string[] = [];
  let writeCount = 0;
  const { runner } = fakeRunner({
    waitForEvent: async (_configDir, eventName) => {
      if (eventName !== UPLOAD_DONE_EVENT) return null;
      // Resolve using whichever filename was most recently written by this
      // operation's own writeFile call, proving no size-based cross-match.
      const filename = filenames[filenames.length - 1];
      return { event: eventName, success: true, cid: `cid-for-${filename}`, filename };
    },
  });
  const adapter = createLogosStorageAdapter(runtime, {
    runner,
    readFile: () => new Uint8Array([1, 2, 3]),
    writeFile: (path) => {
      writeCount += 1;
      filenames.push(path.split('/').pop() ?? path);
    },
  });
  const sameSizePayload = new Uint8Array([1, 2, 3]);
  const [cidA, cidB] = await Promise.all([
    adapter.publish(sameSizePayload),
    adapter.publish(sameSizePayload),
  ]);
  expect(writeCount).toBe(2);
  expect(cidA).not.toBe(cidB);
  expect(cidA).toMatch(/^cid-for-/);
  expect(cidB).toMatch(/^cid-for-/);
});

/**
 * An event-bus fake modelling real `logosctl watch` semantics: a completion
 * event is delivered only to watches that are ALREADY subscribed when it
 * fires. `uploadUrl`/`downloadToUrl` emit their completion synchronously
 * inside `call`, so only a watch armed before the call can observe it.
 */
function busRunner(opts: { uploadCid?: string; downloadEventSessionId?: string; manifests?: (filename: string) => unknown } = {}) {
  const bus = new EventEmitter();
  const calls: Call[] = [];
  let cancelled = 0;
  let lastUploadFilename = '';
  const runner = {
    async call(configDir: string, method: string, args: string[] = []) {
      calls.push({ configDir, method, args });
      if (method === 'peerId') return `peer-${configDir}`;
      if (method === 'connect') return { connected: true };
      if (method === 'exists') return true;
      if (method === 'manifests') return opts.manifests ? opts.manifests(lastUploadFilename) : [];
      if (method === 'uploadUrl') {
        lastUploadFilename = (args[0] ?? '').split('/').pop() ?? '';
        // Real event shape after eventBody(): {event, cid, sessionId, success}; no filename.
        bus.emit(`${configDir}:${UPLOAD_DONE_EVENT}`, {
          event: UPLOAD_DONE_EVENT, cid: opts.uploadCid ?? 'cid-sync', sessionId: 'session-1', success: true,
        });
        return 'session-1';
      }
      if (method === 'downloadToUrl') {
        // Real live shape: {sessionId, success} only, no cid; correlated by
        // the sessionId that downloadToUrl returned.
        bus.emit(`${configDir}:${DOWNLOAD_DONE_EVENT}`, {
          event: DOWNLOAD_DONE_EVENT, sessionId: opts.downloadEventSessionId ?? 'session-2', success: true,
        });
        return 'session-2';
      }
      return null;
    },
    subscribe(configDir: string, eventName: string, timeoutMs: number) {
      calls.push({ configDir, method: `watch:${eventName}`, args: [String(timeoutMs)] });
      const key = `${configDir}:${eventName}`;
      let listener: (body: Record<string, unknown>) => void = () => undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const event = new Promise<Record<string, unknown> | null>((resolve) => {
        listener = (body) => { clearTimeout(timer); resolve(body); };
        timer = setTimeout(() => { bus.off(key, listener); resolve(null); }, Math.min(timeoutMs, 50));
        bus.once(key, listener);
      });
      return {
        ready: Promise.resolve(),
        event,
        cancel() { cancelled += 1; clearTimeout(timer); bus.off(key, listener); },
      };
    },
  };
  return { runner: runner as LogosRunner, calls, cancelledCount: () => cancelled };
}

test('publish observes a storageUploadDone event fired synchronously during uploadUrl (watch armed before the call)', async () => {
  const { runner, calls, cancelledCount } = busRunner({ uploadCid: 'cid-sync-up' });
  const adapter = createLogosStorageAdapter(runtime, { runner, readFile: () => new Uint8Array([1]), writeFile: () => undefined }, { uploadTimeoutMs: 50 });
  const cid = await adapter.publish(new Uint8Array([1, 2]));
  expect(cid).toBe('cid-sync-up');
  const watchIdx = calls.findIndex((c) => c.method === `watch:${UPLOAD_DONE_EVENT}`);
  const uploadIdx = calls.findIndex((c) => c.method === 'uploadUrl');
  expect(watchIdx).toBeGreaterThanOrEqual(0);
  expect(watchIdx).toBeLessThan(uploadIdx);
  expect(cancelledCount()).toBeGreaterThanOrEqual(1);
});

test('fetch observes a storageDownloadDone event fired synchronously during downloadToUrl (watch armed before the call)', async () => {
  const bytes = new Uint8Array([7, 7, 7]);
  const { runner, calls, cancelledCount } = busRunner();
  const adapter = createLogosStorageAdapter(runtime, { runner, readFile: () => bytes, writeFile: () => undefined }, { downloadTimeoutMs: 50 });
  expect(await adapter.fetch('cid-dl')).toEqual(bytes);
  const watchIdx = calls.findIndex((c) => c.method === `watch:${DOWNLOAD_DONE_EVENT}`);
  const dlIdx = calls.findIndex((c) => c.method === 'downloadToUrl');
  expect(watchIdx).toBeGreaterThanOrEqual(0);
  expect(watchIdx).toBeLessThan(dlIdx);
  expect(calls.every((c) => c.configDir === REPLICA)).toBe(true);
  expect(cancelledCount()).toBeGreaterThanOrEqual(1);
});

test('a download event (live shape: sessionId, no cid) for a different session is not accepted as completion', async () => {
  const { runner } = busRunner({ downloadEventSessionId: 'someone-elses-session' });
  const adapter = createLogosStorageAdapter(runtime, { runner, readFile: () => new Uint8Array([1]), writeFile: () => undefined }, { downloadTimeoutMs: 50 });
  await expect(adapter.fetch('cid-dl')).rejects.toThrow(/session/);
});

test('a missed upload event falls back to the origin manifest list, matched by this upload\'s filename', async () => {
  const bus = busRunner({
    manifests: (filename) => [
      { filename: 'someone-else.ssf1', cid: 'cid-other' },
      { filename, cid: 'cid-from-manifest' },
    ],
  });
  // Drop the event entirely: the watch never sees it.
  const inner = bus.runner as unknown as { subscribe: (...a: [string, string, number]) => { ready: Promise<void>; event: Promise<unknown>; cancel(): void } };
  const origSubscribe = inner.subscribe.bind(inner);
  inner.subscribe = (configDir, eventName, timeoutMs) => {
    const sub = origSubscribe(configDir, eventName, timeoutMs);
    sub.cancel();
    return { ...sub, event: Promise.resolve(null) };
  };
  const adapter = createLogosStorageAdapter(runtime, { runner: bus.runner, readFile: () => new Uint8Array([1]), writeFile: () => undefined }, { uploadTimeoutMs: 50 });
  expect(await adapter.publish(new Uint8Array([1, 2]))).toBe('cid-from-manifest');
});

test('a missed upload event with no matching manifest still fails as a timeout', async () => {
  const bus = busRunner({ manifests: () => [{ filename: 'someone-else.ssf1', cid: 'cid-other' }] });
  const inner = bus.runner as unknown as { subscribe: (...a: [string, string, number]) => { ready: Promise<void>; event: Promise<unknown>; cancel(): void } };
  const origSubscribe = inner.subscribe.bind(inner);
  inner.subscribe = (configDir, eventName, timeoutMs) => {
    const sub = origSubscribe(configDir, eventName, timeoutMs);
    sub.cancel();
    return { ...sub, event: Promise.resolve(null) };
  };
  const adapter = createLogosStorageAdapter(runtime, { runner: bus.runner, readFile: () => new Uint8Array([1]), writeFile: () => undefined }, { uploadTimeoutMs: 50 });
  await expect(adapter.publish(new Uint8Array([1, 2]))).rejects.toThrow(/timed out/);
});

test('detectLogosRuntime requires explicit env configuration; no hardcoded historical worktree candidates', async () => {
  const { detectLogosRuntime } = await import('../../src/adapters/storage.ts');
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../src/adapters/storage.ts', import.meta.url), 'utf8'));
  expect(source).not.toMatch(/\.worktrees\/feat-mvp-t2/);
  expect(source).not.toMatch(/appimage_extracted_/);
  expect(typeof detectLogosRuntime).toBe('function');
});
