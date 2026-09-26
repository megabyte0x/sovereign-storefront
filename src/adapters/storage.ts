import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { StorageAdapter } from '../contracts/types.ts';
import { FIRST_RELEASE_MAX_CIPHERTEXT_BYTES, PayloadTooLarge, sha256Hex } from './crypto.ts';

export const LOGOSCTL_VERSION = '0.2.3';
export const STORAGE_MODULE = 'storage_module';
export const STORAGE_MODULE_VERSION = '2.1.2';
export const STORAGE_MODULE_ROOT_HASH =
  '19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740';
export const UPLOAD_DONE_EVENT = 'storageUploadDone';
export const DOWNLOAD_DONE_EVENT = 'storageDownloadDone';
const CHUNK_SIZE = 65_536;
const DEFAULT_UPLOAD_TIMEOUT_MS = 90_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 90_000;
const DOWNLOAD_SETTLE_MS = 10_000;

export type MemoryStorageAdapter = StorageAdapter & {
  uploaded: string[];
  setReplica(up: boolean): void;
  disconnect(): void;
};

export function createMemoryStorageAdapter(): MemoryStorageAdapter {
  const objects = new Map<string, Uint8Array>();
  const uploaded: string[] = [];
  let replicaUp = true;
  let next = 0;

  return {
    uploaded,
    setReplica(up) {
      replicaUp = up;
    },
    disconnect() {
      replicaUp = false;
    },
    async publish(ciphertext) {
      if (ciphertext.byteLength > FIRST_RELEASE_MAX_CIPHERTEXT_BYTES) {
        throw new PayloadTooLarge(ciphertext.byteLength, FIRST_RELEASE_MAX_CIPHERTEXT_BYTES);
      }
      const cid = `mem-${++next}-${sha256Hex(ciphertext).slice(0, 12)}`;
      objects.set(cid, new Uint8Array(ciphertext));
      uploaded.push(cid);
      return cid;
    },
    async fetch(cid) {
      if (!replicaUp) {
        throw new Error('replica unavailable');
      }
      const body = objects.get(cid);
      if (!body) {
        throw new Error('unpublished product');
      }
      return new Uint8Array(body);
    },
    async verifyReplica(cid) {
      if (!replicaUp) return false;
      return objects.has(cid);
    },
  };
}

// --- Live Logos adapter ---------------------------------------------------
//
// `LogosRunner` is the narrow surface `createLogosStorageAdapter` actually
// uses: one-shot RPC calls and a single bounded wait for a named completion
// event. Unit tests inject a fake runner that records exactly which
// `configDir` each call targeted and scripts exactly what each wait
// resolves with, so origin-vs-replica addressing and exact event/CID
// correlation are genuinely testable without a live two-node Logos runtime.

type LogosCall = { status: number | null; stdout: string; stderr: string };

function logosEnv(): NodeJS.ProcessEnv {
  return { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' };
}

function callRaw(logosctlPath: string, configDir: string, args: string[], timeoutMs = 60_000): LogosCall {
  const result = spawnSync(logosctlPath, ['--config-dir', configDir, '--json', ...args], {
    env: logosEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function unwrap(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`logosctl error: ${JSON.stringify(parsed)}`);
  }
  const record = parsed as { status?: string; result?: unknown };
  if (record.status === 'error') {
    throw new Error(`logosctl error: ${JSON.stringify(parsed)}`);
  }
  return record.result;
}

function resultValue(parsed: unknown): unknown {
  const result = unwrap(parsed);
  if (result && typeof result === 'object' && 'success' in result) {
    const body = result as { success: boolean; value?: unknown };
    if (!body.success) {
      throw new Error(`module call failed: ${JSON.stringify(result)}`);
    }
    return body.value;
  }
  return result;
}

function eventBody(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as { event?: string; data?: { arg0?: string } };
  const arg0 = record.data?.arg0;
  if (typeof arg0 === 'string') {
    try {
      return { event: record.event, ...(JSON.parse(arg0) as object) };
    } catch {
      return { event: record.event };
    }
  }
  return { event: record.event };
}

/**
 * An armed `logosctl watch` subscription. `ready` resolves once the watch
 * is attached (so a completion fired by a subsequent call is observable);
 * `event` resolves with the first matching completion body, or `null` if
 * `timeoutMs` elapses (a hang, never a false success). `cancel` must always
 * be called (idempotent) so no watch process leaks.
 */
export type LogosSubscription = {
  ready: Promise<void>;
  event: Promise<Record<string, unknown> | null>;
  cancel(): void;
};

/**
 * Narrow surface used by `createLogosStorageAdapter`. `call` issues one
 * synchronous-style RPC and returns its unwrapped value. `subscribe` arms a
 * watch for exactly one named event on one config dir. Completion events
 * (`storageUploadDone`/`storageDownloadDone`) fire within milliseconds of
 * `uploadUrl`/`downloadToUrl` and are only delivered to watches already
 * attached, so the adapter must subscribe and await `ready` BEFORE calling.
 */
export type LogosRunner = {
  call(configDir: string, method: string, args?: string[]): Promise<unknown>;
  subscribe(configDir: string, eventName: string, timeoutMs: number): LogosSubscription;
};

// Observed live: `logosctl watch` prints nothing on attach, and an event
// fired <1 s after spawn is missed. The live bring-up smoke waits 1 s.
const WATCH_ATTACH_MS = 1_000;

export function defaultLogosRunner(logosctlPath: string): LogosRunner {
  return {
    async call(configDir, method, args = []) {
      if (method === 'fetch') {
        throw new Error('storage_module fetch() is acceptance-only and must not be used');
      }
      const raw = callRaw(logosctlPath, configDir, ['call', STORAGE_MODULE, method, ...args]);
      if (raw.status !== 0 && !raw.stdout) {
        throw new Error(`logosctl call ${method} exited with status ${raw.status}: ${raw.stderr}`);
      }
      return resultValue(parseJson(raw.stdout));
    },
    subscribe(configDir, eventName, timeoutMs) {
      // Own process group: the AppImage wrapper leaves the real logosctl as
      // a grandchild, and `watch` was observed to survive SIGTERM, so the
      // whole group is SIGKILLed on cancel.
      const proc = spawn(
        logosctlPath,
        ['--config-dir', configDir, '--json', 'watch', STORAGE_MODULE, '--event', eventName],
        { env: logosEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true },
      );
      let killed = false;
      const kill = () => {
        if (killed) return;
        killed = true;
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        try {
          if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
        } catch {
          try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        }
        proc.unref();
      };
      let settle: (value: Record<string, unknown> | null) => void = () => undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let attachTimer: ReturnType<typeof setTimeout> | undefined;
      let markReady: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
        attachTimer = setTimeout(resolve, WATCH_ATTACH_MS);
      });
      const event = new Promise<Record<string, unknown> | null>((resolve) => {
        let settled = false;
        settle = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(attachTimer);
          markReady();
          kill();
          resolve(value);
        };
      });
      timer = setTimeout(() => settle(null), timeoutMs);
      let buffer = '';
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            try {
              const body = eventBody(JSON.parse(line));
              if (body?.event === eventName) {
                settle(body);
                return;
              }
            } catch {
              // ignore non-JSON watch lines
            }
          }
          idx = buffer.indexOf('\n');
        }
      });
      proc.on('error', () => settle(null));
      proc.on('exit', () => settle(null));
      return { ready, event, cancel: () => settle(null) };
    },
  };
}

/** CID of the manifest whose filename matches, from an unwrapped `manifests` value. */
export function cidFromManifestList(list: unknown, filename: string): string | undefined {
  if (!Array.isArray(list)) return undefined;
  const match = list.find(
    (m) => m && typeof m === 'object' && (m as { filename?: unknown }).filename === filename
      && typeof (m as { cid?: unknown }).cid === 'string',
  ) as { cid: string } | undefined;
  return match?.cid;
}

export type LogosRuntime = {
  logosctlPath: string;
  originConfigDir: string;
  replicaConfigDir: string;
  /**
   * Origin's fixed loopback listen port. When set, replication connects by
   * the explicit `/ip4/127.0.0.1/tcp/<port>/p2p/<peer>` multiaddr: an empty
   * address hint never discovers a loopback-only origin via the DHT.
   */
  originListenPort?: number;
};

export type LogosDetection =
  | { ok: true; runtime: LogosRuntime }
  | { ok: false; reason: string };

/**
 * Live two-node Logos runtime must be explicitly configured via
 * `LOGOSCTL`/`LOGOS_NODE_A`/`LOGOS_NODE_B`; no hardcoded historical
 * worktree/scratch path candidates are probed.
 */
export function detectLogosRuntime(): LogosDetection {
  const logosctlPath = process.env.LOGOSCTL ?? '';
  const originConfigDir = process.env.LOGOS_NODE_A ?? '';
  const replicaConfigDir = process.env.LOGOS_NODE_B ?? '';
  if (!logosctlPath || !originConfigDir || !replicaConfigDir) {
    return { ok: false, reason: 'LOGOSCTL/LOGOS_NODE_A/LOGOS_NODE_B not configured' };
  }
  const runtime: LogosRuntime = { logosctlPath, originConfigDir, replicaConfigDir };
  try {
    const peerA = resultValue(parseJson(callRaw(logosctlPath, originConfigDir, ['call', STORAGE_MODULE, 'peerId']).stdout));
    const peerB = resultValue(parseJson(callRaw(logosctlPath, replicaConfigDir, ['call', STORAGE_MODULE, 'peerId']).stdout));
    if (typeof peerA === 'string' && typeof peerB === 'string' && peerA !== peerB) {
      return { ok: true, runtime };
    }
    return { ok: false, reason: `peer ids not independent: ${String(peerA)} vs ${String(peerB)}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export type LogosAdapterDeps = {
  runner?: LogosRunner;
  readFile?: (path: string) => Uint8Array;
  writeFile?: (path: string, data: Uint8Array) => void;
  workDir?: string;
};

export type LogosAdapterOptions = {
  maxBytes?: number;
  uploadTimeoutMs?: number;
  downloadTimeoutMs?: number;
  /** Attempts for a transient "Failed to start download." (default 4). */
  downloadAttempts?: number;
  /** Delay between those attempts (default 2000 ms). */
  downloadRetryDelayMs?: number;
};

const DEFAULT_DOWNLOAD_ATTEMPTS = 4;
const DEFAULT_DOWNLOAD_RETRY_DELAY_MS = 2_000;
const TRANSIENT_DOWNLOAD_RE = /Failed to start download/;

/**
 * Serializes all one-shot operations on a single config dir. Real logosctl
 * `watch` output is not scoped to the caller that triggered a given
 * `call`, so without serialization a second concurrent operation's
 * completion event could be misread as belonging to the first. Rather than
 * guess which event belongs to which request via a same-size/first-new-
 * manifest heuristic, each config dir processes one operation at a time.
 */
function createQueue() {
  const locks = new Map<string, Promise<unknown>>();
  return function withLock<T>(configDir: string, fn: () => Promise<T>): Promise<T> {
    const prior = locks.get(configDir) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    locks.set(configDir, run.catch(() => undefined));
    return run;
  };
}

export function createLogosStorageAdapter(
  runtime: LogosRuntime,
  deps: LogosAdapterDeps = {},
  options: LogosAdapterOptions = {},
): StorageAdapter {
  const runner = deps.runner ?? defaultLogosRunner(runtime.logosctlPath);
  const readFile = deps.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)));
  const writeFile = deps.writeFile ?? ((path: string, data: Uint8Array) => writeFileSync(path, data, { mode: 0o600 }));
  const workDir = deps.workDir ?? mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-logos-'));
  const maxBytes = options.maxBytes ?? FIRST_RELEASE_MAX_CIPHERTEXT_BYTES;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const downloadAttempts = Math.max(1, options.downloadAttempts ?? DEFAULT_DOWNLOAD_ATTEMPTS);
  const downloadRetryDelayMs = options.downloadRetryDelayMs ?? DEFAULT_DOWNLOAD_RETRY_DELAY_MS;
  const withLock = createQueue();

  function tryRead(path: string): Uint8Array {
    try {
      return readFile(path);
    } catch {
      return new Uint8Array(0);
    }
  }

  /**
   * The completion event can precede the final write (observed live: digest
   * mismatch on a partially written file). When the replica's manifest
   * reports a datasetSize, wait briefly for the file to reach it.
   */
  async function readCompleteDownload(destPath: string, cid: string): Promise<Uint8Array> {
    let bytes = tryRead(destPath);
    let expected: number | undefined;
    try {
      const list = await runner.call(runtime.replicaConfigDir, 'manifests');
      const entry = Array.isArray(list)
        ? (list.find((m) => m && typeof m === 'object' && (m as { cid?: unknown }).cid === cid) as { datasetSize?: unknown } | undefined)
        : undefined;
      if (typeof entry?.datasetSize === 'number') expected = entry.datasetSize;
    } catch {
      expected = undefined;
    }
    if (expected === undefined) return bytes;
    const deadline = Date.now() + DOWNLOAD_SETTLE_MS;
    while (bytes.byteLength !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      bytes = tryRead(destPath);
    }
    if (bytes.byteLength !== expected && bytes.byteLength <= maxBytes) {
      throw new Error(`download incomplete: ${bytes.byteLength} of ${expected} bytes at ${destPath}`);
    }
    return bytes;
  }

  async function uploadAndWait(ciphertext: Uint8Array): Promise<string> {
    return withLock(runtime.originConfigDir, async () => {
      const filePath = join(workDir, `upload-${randomUUID()}.ssf1`);
      const filename = basename(filePath);
      writeFile(filePath, ciphertext);
      // Arm the watch BEFORE uploadUrl: the completion event fires within
      // milliseconds and is not replayed to watches attached later.
      const sub = runner.subscribe(runtime.originConfigDir, UPLOAD_DONE_EVENT, uploadTimeoutMs);
      let cid: unknown;
      try {
        await sub.ready;
        const sessionId = await runner.call(runtime.originConfigDir, 'uploadUrl', [filePath, String(CHUNK_SIZE)]);
        const event = await sub.event;
        if (event) {
          if (event.success !== true) {
            throw new Error(`upload failed: ${JSON.stringify(event)}`);
          }
          if (event.sessionId !== undefined && sessionId != null && String(event.sessionId) !== String(sessionId)) {
            throw new Error(`upload completion event belongs to a different session (${String(event.sessionId)} != ${String(sessionId)})`);
          }
          if (typeof event.filename === 'string' && event.filename !== filename) {
            throw new Error(`upload completion event correlates to a different file (${event.filename} != ${filename})`);
          }
          cid = event.cid;
        } else {
          // Missed/absent event: the origin manifest list is the durable
          // completion record, correlated by this upload's unique filename.
          cid = cidFromManifestList(await runner.call(runtime.originConfigDir, 'manifests'), filename);
          if (cid === undefined) {
            throw new Error(`timed out waiting for ${UPLOAD_DONE_EVENT}: no event received within ${uploadTimeoutMs}ms`);
          }
        }
      } finally {
        sub.cancel();
      }
      if (typeof cid !== 'string' || cid.length === 0) {
        throw new Error('upload completion event missing cid');
      }
      const exists = await runner.call(runtime.originConfigDir, 'exists', [cid]);
      if (exists !== true) {
        throw new Error(`uploaded cid ${cid} not confirmed present on origin`);
      }
      return cid;
    });
  }

  async function downloadAndWait(cid: string): Promise<Uint8Array> {
    return withLock(runtime.replicaConfigDir, async () => {
      const destPath = join(workDir, `download-${randomUUID()}.ssf1`);
      try {
        return await downloadInto(cid, destPath);
      } finally {
        // Every readiness probe downloads; never leave the file behind.
        rmSync(destPath, { force: true });
      }
    });
  }

  async function downloadInto(cid: string, destPath: string): Promise<Uint8Array> {
    await runner.call(runtime.replicaConfigDir, 'downloadManifest', [cid]);
    let event: Record<string, unknown> | null = null;
    let sessionId: unknown;
    // Observed live (and retried in logos-up.ts): a downloadToUrl right
    // after connect can fail with "Failed to start download." and succeed
    // moments later. Retry only that error, each time with a fresh watch.
    for (let attempt = 1; ; attempt += 1) {
      const sub = runner.subscribe(runtime.replicaConfigDir, DOWNLOAD_DONE_EVENT, downloadTimeoutMs);
      try {
        await sub.ready;
        sessionId = await runner.call(runtime.replicaConfigDir, 'downloadToUrl', [cid, destPath, 'false', String(CHUNK_SIZE)]);
        event = await sub.event;
        break;
      } catch (error) {
        const transient = error instanceof Error && TRANSIENT_DOWNLOAD_RE.test(error.message);
        if (!transient || attempt >= downloadAttempts) throw error;
      } finally {
        sub.cancel();
      }
      await new Promise((resolve) => setTimeout(resolve, downloadRetryDelayMs));
    }
    if (!event) {
      throw new Error(`timed out waiting for ${DOWNLOAD_DONE_EVENT}: no event received within ${downloadTimeoutMs}ms`);
    }
    if (event.success !== true) {
      throw new Error(`download failed: ${JSON.stringify(event)}`);
    }
    // Live storage_module 2.1.2 emits {sessionId, success} (no cid) and
    // correlation is by the sessionId downloadToUrl returned. A cid, when
    // present, must also match. An event with neither is uncorrelated.
    if (event.cid !== undefined && event.cid !== cid) {
      throw new Error(`download completion event reports cid ${String(event.cid)}, expected ${cid}`);
    }
    if (event.sessionId !== undefined) {
      if (sessionId == null || String(event.sessionId) !== String(sessionId)) {
        throw new Error(`download completion event belongs to a different session (${String(event.sessionId)} != ${String(sessionId)})`);
      }
    } else if (event.cid === undefined) {
      throw new Error('download completion event carries neither cid nor sessionId; cannot correlate');
    }
    const bytes = await readCompleteDownload(destPath, cid);
    if (bytes.byteLength === 0) {
      throw new Error(`download did not materialize ${destPath}`);
    }
    if (bytes.byteLength > maxBytes) {
      throw new PayloadTooLarge(bytes.byteLength, maxBytes);
    }
    return bytes;
  }

  /**
   * Replica connects to origin as part of publication/replication setup,
   * not as a prerequisite injected into every `fetch`/`verifyReplica` call.
   * `fetch`/`verifyReplica` address the replica directly and never touch
   * origin.
   */
  async function establishReplication(): Promise<void> {
    return withLock(runtime.replicaConfigDir, async () => {
      const peerId = await runner.call(runtime.originConfigDir, 'peerId');
      if (typeof peerId === 'string' && peerId.length > 0) {
        const port = runtime.originListenPort;
        const hint = port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535
          ? `json:[${JSON.stringify(`/ip4/127.0.0.1/tcp/${port}/p2p/${peerId}`)}]`
          : 'json:[]';
        await runner.call(runtime.replicaConfigDir, 'connect', [peerId, hint]);
      }
    });
  }

  return {
    async publish(ciphertext) {
      if (ciphertext.byteLength > maxBytes) {
        throw new PayloadTooLarge(ciphertext.byteLength, maxBytes);
      }
      const cid = await uploadAndWait(ciphertext);
      await establishReplication();
      return cid;
    },
    async fetch(cid) {
      return downloadAndWait(cid);
    },
    async verifyReplica(cid) {
      try {
        const bytes = await downloadAndWait(cid);
        return bytes.byteLength > 0 && bytes.byteLength <= maxBytes;
      } catch {
        return false;
      }
    },
  };
}
